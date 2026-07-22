import type { AssistantMessage, Tool as PiTool } from "@earendil-works/pi-ai";
import { resolveAgentRunnerProvider } from "../../agent/providers/index.js";
import type {
  AgentRunnerSendOptions,
  AgentRunnerSession,
  AgentRunnerToolExecutor,
} from "../../agent/providers/interface.js";
import { assistantFromText } from "../../agentRun/sessionHelpers.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import { AppError, errorLogFields, toAppError } from "../../errors/appError.js";
import { logInfo, logWarn } from "../../evlog.js";
import {
  MAX_TOOL_ROUNDS,
  ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
  PUBLISH_RECOVERY_ROUNDS,
  TOKEN_FRESHNESS_BUFFER_MS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.js";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.js";
import type { ReviewPayload } from "../reviewSchema.js";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordAgentTurnMetrics,
  setReviewRunMetricFields,
} from "../run/reviewRunMetrics.js";
import { buildReviewRunSetup } from "../run/reviewRunSetup.js";
import type { ReviewRunParams, ReviewRunResult } from "../run/reviewRunTypes.js";
import { buildSpecialistBriefTool, renderBriefMessage, type SpecialistBrief } from "./briefTool.js";
import { pumpSpecialistCompletions } from "./completionPump.js";
import {
  ORCHESTRATOR_RECON_INSTRUCTION,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
  renderSynthesisTurn,
} from "./prompts/orchestratorPrompts.js";
import {
  createFindingLedger,
  SPECIALIST_IDS,
  type OrchestratedRunState,
  type ReviewCoverage,
  type ReviewRunGate,
  type ReviewRunTiming,
  type SpecialistId,
  type SpecialistOutcome,
} from "./orchestratorTypes.js";
import { buildPublishSummaryTool, createPublishSummaryState } from "./publishSummaryTool.js";
import { buildPublishThreadTool } from "./publishThreadTool.js";
import { runSpecialist } from "./specialistRun.js";
import { tickProgressComment } from "./stubTick.js";

export type OrchestratedReviewRunParams = ReviewRunParams & {
  readonly timing: ReviewRunTiming;
  readonly gate: ReviewRunGate;
  readonly prTitle: string;
  readonly prBody: string | null;
};

type SendResult =
  | { readonly kind: "sent"; readonly text: string }
  | { readonly kind: "failed"; readonly error: AppError };

type DeadlineResult<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "deadline" };

async function settleBefore<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<DeadlineResult<T>> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return { kind: "deadline" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), remainingMs);
  });
  const settled: Promise<DeadlineResult<T>> = promise.then(
    (value) => ({ kind: "settled", value }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  const result = await Promise.race([settled, deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

function tokenTtlMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : TOKEN_FRESHNESS_BUFFER_MS;
}

function initialState(): OrchestratedRunState {
  return {
    recon: "running",
    specialists: {
      correctness: { phase: "waiting" },
      security: { phase: "waiting" },
      quality: { phase: "waiting" },
      tests: { phase: "waiting" },
    },
    outcomes: {},
    completionOrder: [],
    failedSpecialists: [],
    briefFallback: false,
    judgment: "model",
    lifecycle: { kind: "running" },
    progressRevision: 0,
    summary: { kind: "pending" },
  };
}

function fallbackBrief(params: OrchestratedReviewRunParams): SpecialistBrief {
  const files = params.workspace.changedFiles.map((file) => file.path);
  const riskFiles = files.slice(0, 12);
  const body = params.prBody?.trim();
  return {
    prIntent: [params.prTitle.trim(), body]
      .filter((part) => part != null && part.length > 0)
      .join("\n\n"),
    architectureNotes: "Reconnaissance did not produce a valid structured brief.",
    riskAreas: riskFiles.map((file) => ({
      area: file.slice(0, 200),
      files: [file],
      reason: "Changed file requires specialist inspection.",
    })),
    fileMap: files.length > 0 ? files.join("\n").slice(0, 6000) : "No changed files were listed.",
    specialistFocus: {
      correctness: "Check behavior, state transitions, and error handling.",
      security: "Check trust boundaries, authorization, and sensitive data handling.",
      quality: "Check maintainability, module ownership, and avoidable complexity.",
      tests: "Check regression coverage and missing failure-path tests.",
    },
  };
}

function initialLedger(params: OrchestratedReviewRunParams) {
  const resumed = params.resumedPlacements ?? [];
  return createFindingLedger({
    accepted: resumed,
    suppressionFingerprints: [
      ...(params.storedInlineFingerprints ?? []),
      ...resumed.map((placement) => placement.canonicalFingerprint),
    ],
    inlineReviewIds: [
      ...(params.initialPublishState?.inlineReviewIds ?? []),
      ...resumed.flatMap((placement) =>
        placement.kind === "summary_only" ? [] : [placement.reviewId],
      ),
    ],
    postedInlineCount: resumed.filter((placement) => placement.kind !== "summary_only").length,
    threadCallCount: params.initialPublishState?.threadCallCount ?? 0,
  });
}

function coverage(state: OrchestratedRunState): ReviewCoverage {
  const failed = [...state.failedSpecialists];
  if (failed.length === 0) return { kind: "full" };
  if (failed.length === SPECIALIST_IDS.length) return { kind: "none", failed };
  const names = failed.join(", ");
  return {
    kind: "partial",
    failed,
    note: `Coverage partial: ${names} specialist${failed.length === 1 ? "" : "s"} failed.`,
  };
}

function transitionTools(
  session: AgentRunnerSession,
  tools: readonly PiTool[],
  executors: Record<string, AgentRunnerToolExecutor>,
): void {
  session.restoreTools();
  session.restrictToTools(tools, executors);
}

/** Specialist completion ticks occupy revisions 2–5 (revision 1 is recon-done). */
function nextProgressRevision(revision: OrchestratedRunState["progressRevision"]): 2 | 3 | 4 | 5 {
  switch (revision) {
    case 0:
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 5;
    case 5:
    case 6:
      return 5;
    default: {
      const exhaustive: never = revision;
      return exhaustive;
    }
  }
}

function deterministicPayload(params: {
  readonly state: OrchestratedRunState;
  readonly findings: ReviewPayload["findings"];
}): ReviewPayload {
  const degraded = params.state.judgment === "degraded";
  return {
    prCharacter: degraded
      ? "Judgment degraded. The deterministic summary preserves every accepted finding."
      : "The orchestrated review completed.",
    findings: [...params.findings],
    estimatedEffort: params.findings.length === 0 ? 1 : Math.min(5, params.findings.length + 1),
    relevantTests: "partial",
    securityConcerns: null,
    followUps: [],
  };
}

export async function runOrchestratedPrReview(
  params: OrchestratedReviewRunParams,
): Promise<ReviewRunResult> {
  if (!Number.isFinite(params.tokenExpiresAtTs)) {
    throw new AppError({
      code: "review.invalid_token_expiry_ts",
      message: "tokenExpiresAtTs must be a finite timestamp in milliseconds",
    });
  }

  const reviewMode = params.mode ?? "review";
  initReviewRunMetrics({
    provider: params.cfg.agentProvider,
    model: params.cfg.piModel,
    mode: reviewMode,
  });
  const setup = buildReviewRunSetup({
    ...params,
    tokenTtlMs: tokenTtlMs(params.tokenTtlMs),
  });
  const briefTool = buildSpecialistBriefTool();
  const state = initialState();
  const publishThread = buildPublishThreadTool({
    ctx: {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      hasDescriptionAgentBlock: params.hasDescriptionAgentBlock ?? false,
    },
    workItemId: params.workItemId,
    getToken: setup.getToken,
    getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
    refreshLiveAuth: setup.refreshLiveAuth,
    cachedDiffIndex: setup.cachedDiffIndex,
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    initialLedger: initialLedger(params),
  });
  const summaryState = createPublishSummaryState({
    published: params.initialPublishState?.published,
  });
  const publishSummary = buildPublishSummaryTool({
    cfg: params.cfg,
    ctx: {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      hasDescriptionAgentBlock: params.hasDescriptionAgentBlock ?? false,
    },
    getToken: setup.getToken,
    getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
    refreshLiveAuth: setup.refreshLiveAuth,
    remainingFinalizationMs: params.timing.remainingTotalMs,
    mode: reviewMode,
    cachedDiffIndex: setup.cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    summaryCommentIdHint: params.summaryCommentIdHint,
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    state: summaryState,
    getLedger: publishThread.getLedger,
    getCoverage: () => coverage(state),
  });
  const allTools = [
    ...setup.workspaceTools.piTools,
    briefTool.piTool,
    publishThread.piTool,
    publishSummary.piTool,
  ];
  const allExecutors = {
    ...setup.workspaceTools.executors,
    submit_specialist_brief: briefTool.executor,
    publish_thread: publishThread.executor,
    publish_summary: publishSummary.executor,
  };
  const provider = resolveAgentRunnerProvider(params.cfg);
  const sessionParams = {
    cfg: params.cfg,
    cwd: params.cwd ?? params.workspace.agentCwd,
    systemPrompt: orchestratorSystemPrompt,
    tools: allTools,
    executors: allExecutors,
    refreshBeforeTool: async (toolName: string) => {
      if (toolName === "publish_thread" || toolName === "publish_summary") {
        await setup.refreshLiveAuth();
        return;
      }
      await setup.refreshBeforeTool(toolName);
    },
  };
  let session: AgentRunnerSession | null = null;
  let sessionCreation: Promise<AgentRunnerSession> | null = null;
  try {
    sessionCreation = provider.createSession(sessionParams);
    const creation = await settleBefore(
      sessionCreation,
      Math.min(params.timing.modelStopAtMs, params.timing.returnByMs),
    );
    if (creation.kind === "settled") {
      session = creation.value;
    } else if (creation.kind === "deadline") {
      state.judgment = "degraded";
      state.lifecycle = { kind: "finalizing", reason: "deadline" };
      void sessionCreation
        .then(async (lateSession) => {
          await lateSession.abort().catch(() => undefined);
          await lateSession.dispose().catch(() => undefined);
        })
        .catch(() => undefined);
      logWarn("review_orchestrator_session_create_deadline", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
      });
    } else {
      state.judgment = "degraded";
      const appError = toAppError(creation.error, {
        code: "review.orchestrator_session_create_failed",
        context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
      });
      logWarn("review_orchestrator_session_create_failed", errorLogFields(appError));
    }
  } catch (error) {
    state.judgment = "degraded";
    const appError = toAppError(error, {
      code: "review.orchestrator_session_create_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
    logWarn("review_orchestrator_session_create_failed", errorLogFields(appError));
  }
  const specialistControllers = new Map<SpecialistId, AbortController>();
  let sessionRetired = session == null;
  let lastText = "";
  let publishAttempts = 0;
  let fatalError: AppError | null = null;

  const retireSession = async (): Promise<void> => {
    if (sessionRetired) return;
    sessionRetired = true;
    if (!session) return;
    const abortPromise = session.abort();
    await settleBefore(abortPromise, params.timing.returnByMs);
    void abortPromise.catch(() => undefined);
  };

  const abortSpecialists = (): void => {
    for (const controller of specialistControllers.values()) controller.abort();
  };

  const markCompleteUnlessStopped = (): void => {
    if (state.lifecycle.kind !== "stopped") state.lifecycle = { kind: "complete" };
  };

  const applyPublishStop = async (): Promise<boolean> => {
    const reason = publishThread.getStopReason() ?? summaryState.stoppedReason;
    if (!reason) return false;
    state.lifecycle = { kind: "stopped", reason };
    abortSpecialists();
    await retireSession();
    return true;
  };

  const sendWithRetry = async (
    phase: "recon" | "judgment" | "synthesis",
    prompt: string,
    options?: AgentRunnerSendOptions,
  ): Promise<SendResult> => {
    let firstError: AppError | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (sessionRetired || !session) {
        return {
          kind: "failed",
          error:
            firstError ??
            new AppError({
              code: "review.orchestrator_session_retired",
              message: "Orchestrator session is no longer available",
              context: { phase },
            }),
        };
      }
      const gate = await params.gate.check();
      if (
        gate.kind === "finalize" ||
        Date.now() >= params.timing.modelStopAtMs ||
        Date.now() >= params.timing.returnByMs
      ) {
        state.lifecycle = { kind: "finalizing", reason: "deadline" };
        abortSpecialists();
        await retireSession();
        return {
          kind: "failed",
          error: new AppError({
            code: "review.orchestrator_model_deadline",
            message: "Orchestrator model deadline reached",
            context: { phase, attempt },
          }),
        };
      }
      if (gate.kind === "stop") {
        state.lifecycle = { kind: "stopped", reason: gate.reason };
        abortSpecialists();
        await retireSession();
        return {
          kind: "failed",
          error: new AppError({
            code: "review.orchestrator_stopped",
            message: "Orchestrator stopped before the model send",
            context: { phase, attempt, reason: gate.reason },
          }),
        };
      }
      try {
        const sendPromise = session.send(prompt, options);
        const send = await settleBefore(
          sendPromise,
          Math.min(params.timing.modelStopAtMs, params.timing.returnByMs),
        );
        if (send.kind === "deadline") {
          state.lifecycle = { kind: "finalizing", reason: "deadline" };
          abortSpecialists();
          await retireSession();
          void sendPromise.catch(() => undefined);
          return {
            kind: "failed",
            error: new AppError({
              code: "review.orchestrator_model_deadline",
              message: "Orchestrator model deadline reached during send",
              context: { phase, attempt },
            }),
          };
        }
        if (send.kind === "rejected") throw send.error;
        recordAgentTurnMetrics(send.value);
        return { kind: "sent", text: send.value.text };
      } catch (error) {
        const appError = toAppError(error, {
          code: "review.orchestrator_send_failed",
          context: { phase, attempt },
        });
        firstError ??= appError;
        logWarn("review_orchestrator_send_retry", {
          phase,
          attempt,
          ...errorLogFields(appError),
        });
      }
    }
    await retireSession();
    return {
      kind: "failed",
      error:
        firstError ??
        new AppError({
          code: "review.orchestrator_send_failed",
          message: "Orchestrator send failed twice",
          context: { phase },
        }),
    };
  };

  const writeTick = async (): Promise<void> => {
    const coordination = params.recordPublishStep?.summaryCommentCoordination;
    const revision = state.progressRevision;
    if (!coordination || revision === 0 || revision === 6) return;
    await tickProgressComment({
      pool: coordination.pool,
      workItemId: coordination.workItemId,
      resourceKey: coordination.resourceKey,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      mode: reviewMode,
      headSha: params.headSha,
      source: params.reviewSource ?? "auto",
      progressRevision: revision,
      tickState: {
        kind: "specialists",
        recon: state.recon,
        specialists: state.specialists,
      },
      getToken: setup.getToken,
      getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
      refreshLiveAuth: setup.refreshLiveAuth,
      hintCommentId: params.summaryCommentIdHint,
    });
  };

  const markReconDoneAndTick = async (): Promise<void> => {
    state.recon = "done";
    for (const specialist of SPECIALIST_IDS) {
      state.specialists[specialist] = { phase: "running" };
    }
    if (state.progressRevision === 0) {
      state.progressRevision = 1;
      await writeTick();
    }
  };

  const writeTerminalTick = async (reason: "superseded" | "stale_head"): Promise<void> => {
    const coordination = params.recordPublishStep?.summaryCommentCoordination;
    if (!coordination) return;
    state.progressRevision = 6;
    await tickProgressComment({
      pool: coordination.pool,
      workItemId: coordination.workItemId,
      resourceKey: coordination.resourceKey,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      mode: reviewMode,
      headSha: params.headSha,
      source: params.reviewSource ?? "auto",
      progressRevision: 6,
      tickState: { kind: "terminal", reason },
      getToken: setup.getToken,
      getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
      refreshLiveAuth: setup.refreshLiveAuth,
      hintCommentId: params.summaryCommentIdHint,
    });
  };

  const recordOutcome = async (outcome: SpecialistOutcome): Promise<void> => {
    if (state.outcomes[outcome.specialist] != null) return;
    state.outcomes[outcome.specialist] = outcome;
    state.completionOrder.push(outcome.specialist);
    state.progressRevision = nextProgressRevision(state.progressRevision);
    if (outcome.kind === "empty") {
      state.specialists[outcome.specialist] = { phase: "no_findings" };
      await writeTick();
    } else if (outcome.kind === "error") {
      state.specialists[outcome.specialist] = { phase: "failed" };
      state.failedSpecialists.push(outcome.specialist);
      logWarn("review_specialist_failed", {
        specialist: outcome.specialist,
        durationMs: outcome.durationMs,
        ...errorLogFields(outcome.error),
      });
      await writeTick();
    }
  };

  const publishReportDeterministically = async (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
  ): Promise<void> => {
    publishThread.setSource(outcome.specialist);
    const before = publishThread.getLedger().postedInlineCount;
    await setup.refreshLiveAuth();
    publishAttempts += 1;
    const result = await publishThread.executor({ findings: outcome.report.findings });
    if (result.kind === "stopped") {
      await applyPublishStop();
      return;
    }
    state.specialists[outcome.specialist] = {
      phase: "done",
      threadsPublished: publishThread.getLedger().postedInlineCount - before,
    };
    await writeTick();
  };

  const degradeReport = async (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
    error?: unknown,
  ): Promise<void> => {
    state.judgment = "degraded";
    if (error !== undefined) {
      const appError = toAppError(error, {
        code: "review.orchestrator_report_handler_failed",
        context: { specialist: outcome.specialist },
      });
      logWarn("review_orchestrator_report_handler_failed", {
        specialist: outcome.specialist,
        ...errorLogFields(appError),
      });
    }
    await retireSession();
    try {
      await publishReportDeterministically(outcome);
    } catch (publishError) {
      fatalError = toAppError(publishError, {
        code: "review.deterministic_finding_publish_failed",
        context: { specialist: outcome.specialist },
      });
      abortSpecialists();
    }
  };

  const publishDeterministicSummary = async (): Promise<void> => {
    const ledger = publishThread.getLedger();
    const payload = deterministicPayload({
      state,
      findings: ledger.accepted.map((accepted) => accepted.placement.finding),
    });
    await setup.refreshLiveAuth();
    publishAttempts += 1;
    const result = await publishReviewSummaryOnly({
      cfg: params.cfg,
      ctx: {
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        headSha: params.headSha,
        hasDescriptionAgentBlock: params.hasDescriptionAgentBlock ?? false,
      },
      getToken: setup.getToken,
      getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
      refreshLiveAuth: setup.refreshLiveAuth,
      remainingFinalizationMs: params.timing.remainingTotalMs,
      payload,
      ledger,
      mode: reviewMode,
      cachedDiffIndex: setup.cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      recordPublishStep: params.recordPublishStep,
      coverage: coverage(state),
      shouldAbortPublish: params.shouldAbortPublish,
      publishAbortState: params.publishAbortState,
    });
    if (result.kind === "stopped") {
      state.lifecycle = { kind: "stopped", reason: result.reason };
      return;
    }
    summaryState.published = true;
    state.summary = { kind: "published" };
  };

  const publishFailureNotice = async (): Promise<void> => {
    await setup.refreshLiveAuth();
    await publishReviewRunFailureNotice({
      cfg: params.cfg,
      setup,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      reviewMode,
      publishAttempts,
    });
    state.summary = { kind: "failed" };
  };

  try {
    if (session) {
      transitionTools(session, [...setup.workspaceTools.piTools, briefTool.piTool], {
        ...setup.workspaceTools.executors,
        submit_specialist_brief: briefTool.executor,
      });
      const recon = await sendWithRetry(
        "recon",
        [setup.orchestratorUserContent, ORCHESTRATOR_RECON_INSTRUCTION].join("\n\n"),
        { maxToolRounds: MAX_TOOL_ROUNDS },
      );
      if (recon.kind === "sent") lastText = recon.text;
      else state.judgment = "degraded";
    }

    if (briefTool.getBrief() == null && !sessionRetired && session) {
      await runValidationRepairLoop({
        rounds: VALIDATION_REPAIR_ROUNDS,
        shouldContinue: () => briefTool.getBrief() == null && !sessionRetired,
        getValidationError: () =>
          briefTool.getValidationError() ?? "No specialist brief was submitted.",
        clearValidationError: briefTool.clearValidationError,
        repair: async (validationError) => {
          transitionTools(session, [briefTool.piTool], {
            submit_specialist_brief: briefTool.executor,
          });
          const repair = await sendWithRetry(
            "recon",
            [
              validationError,
              "Fix the brief and call submit_specialist_brief now. Do not use any other tools.",
            ].join("\n\n"),
          );
          if (repair.kind === "sent") lastText = repair.text;
          else state.judgment = "degraded";
        },
      });
    }

    const brief = briefTool.getBrief() ?? fallbackBrief(params);
    if (briefTool.getBrief() == null) {
      state.briefFallback = true;
      logWarn("review_brief_fallback", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        sessionRetired,
      });
    }
    await markReconDoneAndTick();

    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>();
    for (const specialist of SPECIALIST_IDS) {
      const controller = new AbortController();
      specialistControllers.set(specialist, controller);
      pending.set(
        specialist,
        runSpecialist({
          cfg: params.cfg,
          cwd: params.cwd ?? params.workspace.agentCwd,
          specialist,
          briefMessage: renderBriefMessage(brief, specialist),
          workspaceTools: setup.workspaceTools,
          timeoutMs: Math.max(
            0,
            Math.min(params.cfg.reviewSpecialistTimeoutMs, params.timing.remainingModelMs()),
          ),
          shouldContinue: () => state.lifecycle.kind === "running",
          signal: controller.signal,
        }),
      );
    }

    const outcomes = await pumpSpecialistCompletions({
      pending,
      shouldContinue: () => state.lifecycle.kind === "running",
      onOutcome: async (outcome) => {
        try {
          const gate = await params.gate.check();
          if (gate.kind !== "continue") {
            state.lifecycle =
              gate.kind === "stop"
                ? { kind: "stopped", reason: gate.reason }
                : { kind: "finalizing", reason: gate.reason };
            abortSpecialists();
            await retireSession();
            return;
          }

          await recordOutcome(outcome);
          if (outcome.kind !== "report") return;
          const judgmentSession = session;
          if (state.judgment === "degraded" || sessionRetired || !judgmentSession) {
            await degradeReport(outcome);
            return;
          }

          publishThread.setSource(outcome.specialist);
          const before = publishThread.getLedger().postedInlineCount;
          transitionTools(judgmentSession, [publishThread.piTool], {
            publish_thread: publishThread.executor,
          });
          publishAttempts += 1;
          const judgment = await sendWithRetry("judgment", renderJudgmentTurn(outcome), {
            maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
          });
          if (judgment.kind === "failed") {
            await degradeReport(outcome, judgment.error);
            return;
          }
          lastText = judgment.text;
          if (await applyPublishStop()) return;
          state.specialists[outcome.specialist] = {
            phase: "done",
            threadsPublished: publishThread.getLedger().postedInlineCount - before,
          };
          await writeTick();
        } catch (error) {
          await recordOutcome(outcome);
          if (outcome.kind === "report") {
            await degradeReport(outcome, error);
            return;
          }
          throw error;
        }
      },
    });

    if (state.lifecycle.kind === "running") {
      for (const outcome of outcomes) {
        if (state.outcomes[outcome.specialist] != null) continue;
        await recordOutcome(outcome);
        if (outcome.kind === "report") await degradeReport(outcome);
      }
    }

    if (fatalError != null) throw fatalError;

    if (state.lifecycle.kind === "stopped") {
      await writeTerminalTick(state.lifecycle.reason);
    } else if (state.lifecycle.kind === "finalizing") {
      for (const outcome of outcomes) {
        if (state.outcomes[outcome.specialist] == null) await recordOutcome(outcome);
        if (
          outcome.kind === "report" &&
          state.specialists[outcome.specialist].phase === "running"
        ) {
          await publishReportDeterministically(outcome);
        }
      }
      state.judgment = "degraded";
      if (state.failedSpecialists.length === SPECIALIST_IDS.length) {
        await publishFailureNotice();
      } else {
        await publishDeterministicSummary();
      }
      markCompleteUnlessStopped();
    } else if (state.failedSpecialists.length === SPECIALIST_IDS.length) {
      await publishFailureNotice();
      state.lifecycle = { kind: "complete" };
    } else if (state.judgment === "degraded" || sessionRetired || !session) {
      await publishDeterministicSummary();
      markCompleteUnlessStopped();
    } else {
      const synthesisSession = session;
      transitionTools(synthesisSession, [publishSummary.piTool], {
        publish_summary: publishSummary.executor,
      });
      publishAttempts += 1;
      const synthesisPrompt = renderSynthesisTurn({
        acceptedFindings: publishThread.getLedger().accepted,
        partialSpecialists: state.failedSpecialists,
        outcomes: state.completionOrder.flatMap((specialist) => {
          const outcome = state.outcomes[specialist];
          return outcome ? [outcome] : [];
        }),
      });
      const synthesis = await sendWithRetry("synthesis", synthesisPrompt);
      if (synthesis.kind === "sent") lastText = synthesis.text;
      else state.judgment = "degraded";
      await applyPublishStop();

      if (!summaryState.published && !sessionRetired && state.lifecycle.kind === "running") {
        await runValidationRepairLoop({
          rounds: VALIDATION_REPAIR_ROUNDS,
          shouldContinue: () =>
            !summaryState.published && !sessionRetired && state.lifecycle.kind === "running",
          getValidationError: () =>
            summaryState.lastValidationError ?? "The summary was not published.",
          clearValidationError: () => {
            summaryState.lastValidationError = null;
          },
          repair: async (validationError) => {
            transitionTools(synthesisSession, [publishSummary.piTool], {
              publish_summary: publishSummary.executor,
            });
            const repair = await sendWithRetry(
              "synthesis",
              [validationError, "Fix the summary and call publish_summary now."].join("\n\n"),
            );
            if (repair.kind === "sent") lastText = repair.text;
            else state.judgment = "degraded";
            await applyPublishStop();
          },
        });
      }

      for (let round = 0; round < PUBLISH_RECOVERY_ROUNDS; round++) {
        if (summaryState.published || sessionRetired || state.lifecycle.kind !== "running") break;
        transitionTools(synthesisSession, [publishSummary.piTool], {
          publish_summary: publishSummary.executor,
        });
        const recovery = await sendWithRetry(
          "synthesis",
          "Call publish_summary now with the complete final review. Do not reply with prose only.",
        );
        if (recovery.kind === "sent") lastText = recovery.text;
        else state.judgment = "degraded";
        await applyPublishStop();
      }

      if (publishThread.getStopReason() != null || summaryState.stoppedReason != null) {
        state.summary = { kind: "pending" };
      } else if (summaryState.published) {
        state.summary = { kind: "published" };
      } else if (state.judgment === "degraded" || sessionRetired) {
        await publishDeterministicSummary();
      } else {
        await publishFailureNotice();
      }
      markCompleteUnlessStopped();
    }
  } catch (error) {
    abortSpecialists();
    await retireSession();
    throw toAppError(error, {
      code: "review.orchestrator_run_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
  } finally {
    if (session) {
      const disposePromise = session.dispose();
      await settleBefore(disposePromise, params.timing.returnByMs);
      void disposePromise.catch(() => undefined);
    }
  }

  const specialistOutcomes: Record<string, number> = {};
  for (const outcome of Object.values(state.outcomes)) {
    if (!outcome) continue;
    specialistOutcomes[outcome.kind] = (specialistOutcomes[outcome.kind] ?? 0) + 1;
  }
  setReviewRunMetricFields({
    published: summaryState.published,
    publishAttempts,
    specialistOutcomes,
    threadBatches: publishThread.getPublishedBatchCount(),
    briefFallback: state.briefFallback,
  });
  logReviewRunCompleted({
    judgment: state.judgment,
    lifecycle: state.lifecycle.kind,
  });
  logInfo("review_orchestrator_completed", {
    owner: params.owner,
    repo: params.repo,
    pr: params.prNumber,
    completionOrder: state.completionOrder,
    judgment: state.judgment,
  });

  const lastAssistant: AssistantMessage = assistantFromText(
    params.cfg,
    lastText,
    params.cfg.agentProvider,
  );
  return {
    lastAssistant,
    published: summaryState.published,
    publishAttempts,
    publishSuperseded: state.lifecycle.kind === "stopped",
  };
}
