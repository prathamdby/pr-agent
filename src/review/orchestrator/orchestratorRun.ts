import { readFile } from "node:fs/promises";
import { reviewCheckDetailsUrl } from "../../agentWork/reviewCheckRun.js";
import { getSummaryCommentGithubId } from "../../agentWork/publishRecordRepository.js";
import { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.js";
import { classifyFallbackEligibility } from "../../agent/runtime/fallbackClassification.js";
import {
  resolveAgentEventsContext,
  safeEmitDecisionEvent,
} from "../../agent/runtime/agentEventSink.js";
import type { PiSession, PiSessionSendOptions } from "../../agent/runtime/types.js";
import { assistantFromText } from "../../agentRun/sessionHelpers.js";
import { runValidationRepairLoop } from "../../agentRun/structuredAgentLoop.js";
import { AppError, errorLogFields, toAppError } from "../../errors/appError.js";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.js";
import { logInfo, logWarn } from "../../evlog.js";
import {
  MAX_TOOL_ROUNDS,
  ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
  PUBLISH_RECOVERY_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.js";
import { assertWorkspacePath } from "../../prWorkspace/localPrWorkspace.js";
import { createAgentCiSummaryAuthor } from "../ci/authorCiSummary.js";
import { createBoundPolicyJudge } from "../publish/boundPolicyJudge.js";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.js";
import type { ReviewPayload } from "../reviewSchema.js";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordAgentTurnMetrics,
  recordClassifiedFailure,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "../run/reviewRunMetrics.js";
import { buildReviewRunSetup } from "../run/reviewRunSetup.js";
import type { ReviewRunParams, ReviewRunResult } from "../run/reviewRunTypes.js";
import { buildSpecialistBriefTool, renderBriefMessage, type SpecialistBrief } from "./briefTool.js";
import { pumpSpecialistCompletions } from "./completionPump.js";
import { resolveDescriptionWritingPolicy } from "../../agent/description/descriptionWritingPolicy.js";
import {
  ORCHESTRATOR_RECON_INSTRUCTION,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
  renderSynthesisTurn,
} from "./prompts/orchestratorPrompts.js";
import {
  createFindingLedger,
  SPECIALIST_IDS,
  specialistDonePhase,
  type OrchestratedRunState,
  type ReviewCoverage,
  type ReviewRunGate,
  type ReviewRunTiming,
  type SpecialistId,
  type SpecialistOutcome,
} from "./orchestratorTypes.js";
import { createOrchestratorPhaseRef } from "./phaseToolPolicy.js";
import {
  buildPublishSummaryTool,
  createPublishSummaryState,
  type PublishSummaryState,
} from "./publishSummaryTool.js";
import { buildPublishThreadTool } from "./publishThreadTool.js";
import { runSpecialist } from "./specialistRun.js";
import { tickProgressComment, writeCancelledProgressComment } from "./stubTick.js";

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
  return {
    prIntent:
      "Reconnaissance did not produce a valid structured brief. Pull request metadata is provided separately as untrusted evidence.",
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
      ...(params.crossPrSuppressionFingerprints ?? []),
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

/** Specialist completion ticks occupy revisions 3–6 (1 worker-start, 2 recon-done). */
function nextProgressRevision(revision: OrchestratedRunState["progressRevision"]): 3 | 4 | 5 | 6 {
  switch (revision) {
    case 0:
    case 1:
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 5;
    case 5:
      return 6;
    case 6:
    case 7:
      return 6;
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
    size: "M",
    relevantTests: "partial",
    securityConcerns: null,
    followUps: [],
  };
}

type RunGateResult = Awaited<ReturnType<ReviewRunGate["check"]>>;

async function resolveOrchestratorProgressCommentUrl(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly reviewMode: NonNullable<OrchestratedReviewRunParams["mode"]> | "review";
}): Promise<string | undefined> {
  const progressCommentCoordination = params.review.recordPublishStep?.summaryCommentCoordination;
  let commentId: number | null | undefined;
  if (progressCommentCoordination) {
    try {
      commentId = await getSummaryCommentGithubId(
        progressCommentCoordination.pool,
        progressCommentCoordination.resourceKey,
        params.reviewMode,
      );
      if (commentId == null) {
        commentId = params.review.progressCommentIdHint;
      }
    } catch (error) {
      const appError = toAppError(error, {
        code: "review.progress_comment_lookup_failed",
      });
      logWarn("review_progress_comment_lookup_failed", errorLogFields(appError));
      commentId = params.review.progressCommentIdHint;
    }
  } else {
    commentId = params.review.progressCommentIdHint;
  }
  return reviewCheckDetailsUrl(
    params.review.owner,
    params.review.repo,
    params.review.prNumber,
    commentId,
  );
}

function orchestratorOperationIntent(
  recordPublishStep: OrchestratedReviewRunParams["recordPublishStep"],
):
  | {
      readonly client: NonNullable<
        NonNullable<OrchestratedReviewRunParams["recordPublishStep"]>["summaryCommentCoordination"]
      >["pool"];
      readonly workItemId: string;
      readonly resourceKey: string;
      readonly leaseEpoch: number | null | undefined;
    }
  | undefined {
  const coordination = recordPublishStep?.summaryCommentCoordination;
  if (!coordination) return undefined;
  return {
    client: coordination.pool,
    workItemId: coordination.workItemId,
    resourceKey: coordination.resourceKey,
    leaseEpoch: coordination.leaseEpoch,
  };
}

function applyCreatedOrchestratorSession(
  state: OrchestratedRunState,
  created: Awaited<ReturnType<typeof createOrchestratorSession>>,
): PiSession | null {
  if (created.degraded) state.judgment = "degraded";
  if (created.deadlineReached) {
    state.lifecycle = { kind: "finalizing", reason: "deadline" };
  }
  return created.session;
}

function completeOrchestratedReviewResult(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly state: OrchestratedRunState;
  readonly summaryState: PublishSummaryState;
  readonly publishAttempts: number;
  readonly lastText: string;
  readonly threadBatches: number;
}): ReviewRunResult {
  const specialistOutcomes: Record<string, number> = {};
  for (const outcome of Object.values(params.state.outcomes)) {
    if (!outcome) continue;
    specialistOutcomes[outcome.kind] = (specialistOutcomes[outcome.kind] ?? 0) + 1;
  }
  setReviewRunMetricFields({
    published: params.summaryState.published,
    publishAttempts: params.publishAttempts,
    specialistOutcomes,
    threadBatches: params.threadBatches,
    briefFallback: params.state.briefFallback,
  });
  logReviewRunCompleted({
    judgment: params.state.judgment,
    lifecycle: params.state.lifecycle.kind,
  });
  logInfo("review_orchestrator_completed", {
    owner: params.review.owner,
    repo: params.review.repo,
    pr: params.review.prNumber,
    completionOrder: params.state.completionOrder,
    judgment: params.state.judgment,
  });
  const lastFailure = snapshotReviewRunMetrics()?.lastFailure ?? undefined;
  return {
    lastAssistant: assistantFromText(
      params.review.cfg,
      params.lastText,
      params.review.cfg.piProvider,
    ),
    published: params.summaryState.published,
    publishAttempts: params.publishAttempts,
    publishSuperseded: params.state.lifecycle.kind === "stopped",
    ...(lastFailure != null ? { lastFailure } : {}),
  };
}

function lifecycleFromRunGate(
  gate: Exclude<RunGateResult, { kind: "continue" }>,
): Extract<OrchestratedRunState["lifecycle"], { kind: "stopped" | "finalizing" }> {
  if (gate.kind === "finalize") {
    return { kind: "finalizing", reason: gate.reason };
  }
  if (gate.reason === "cancelled") {
    return {
      kind: "stopped",
      reason: "cancelled",
      attribution: gate.attribution,
    };
  }
  return { kind: "stopped", reason: gate.reason };
}

async function createOrchestratorSession(params: {
  readonly cfg: OrchestratedReviewRunParams["cfg"];
  readonly cwd: string;
  readonly tools: Parameters<typeof createFeaturePiSession>[0]["tools"];
  readonly executors: Parameters<typeof createFeaturePiSession>[0]["executors"];
  readonly durability: OrchestratedReviewRunParams["durability"];
  readonly deadlineMs: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): Promise<{
  readonly session: PiSession | null;
  readonly sessionCreation: Promise<PiSession> | null;
  readonly degraded: boolean;
  readonly deadlineReached: boolean;
}> {
  let sessionCreation: Promise<PiSession> | null = null;
  try {
    sessionCreation = createFeaturePiSession({
      role: "orchestrator",
      cfg: params.cfg,
      cwd: params.cwd,
      systemPrompt: orchestratorSystemPrompt,
      tools: params.tools,
      executors: params.executors,
      durability: params.durability,
    });
    const creation = await settleBefore(sessionCreation, params.deadlineMs);
    if (creation.kind === "settled") {
      return { session: creation.value, sessionCreation, degraded: false, deadlineReached: false };
    }
    if (creation.kind === "deadline") {
      void sessionCreation
        .then(async (lateSession) => {
          await lateSession.abort().catch(() => undefined);
          await lateSession.dispose().catch(() => undefined);
        })
        .catch(() => undefined);
      const deadlineFailure = classifyFailure(
        new AppError({
          code: "review.orchestrator_session_create_deadline",
          message: "Orchestrator session create deadline reached",
          context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
        }),
        { phase: "recon" },
      );
      recordClassifiedFailure(deadlineFailure);
      logWarn("review_orchestrator_session_create_deadline", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        ...classifiedFailureLogFields(deadlineFailure),
      });
      return { session: null, sessionCreation, degraded: true, deadlineReached: true };
    }
    const appError = toAppError(creation.error, {
      code: "review.orchestrator_session_create_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
    const failure = classifyFailure(appError, { phase: "recon" });
    recordClassifiedFailure(failure);
    logWarn("review_orchestrator_session_create_failed", {
      ...errorLogFields(appError),
      ...classifiedFailureLogFields(failure),
    });
    return { session: null, sessionCreation, degraded: true, deadlineReached: false };
  } catch (error) {
    const appError = toAppError(error, {
      code: "review.orchestrator_session_create_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
    const failure = classifyFailure(appError, { phase: "recon" });
    recordClassifiedFailure(failure);
    logWarn("review_orchestrator_session_create_failed", {
      ...errorLogFields(appError),
      ...classifiedFailureLogFields(failure),
    });
    return { session: null, sessionCreation, degraded: true, deadlineReached: false };
  }
}

function startSpecialistRuns(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly brief: SpecialistBrief;
  readonly submittedBrief: SpecialistBrief | null;
  readonly workspaceTools: ReturnType<typeof buildReviewRunSetup>["workspaceTools"];
  readonly evidenceLedger: ReturnType<typeof buildReviewRunSetup>["evidenceLedger"];
  readonly shouldContinue: () => boolean;
  readonly agentEvents: ReturnType<typeof resolveAgentEventsContext>;
  readonly specialistControllers: Map<SpecialistId, AbortController>;
}): Map<SpecialistId, Promise<SpecialistOutcome>> {
  const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>();
  for (const specialist of SPECIALIST_IDS) {
    const controller = new AbortController();
    params.specialistControllers.set(specialist, controller);
    pending.set(
      specialist,
      runSpecialist({
        cfg: params.review.cfg,
        cwd: params.review.cwd ?? params.review.workspace.agentCwd,
        specialist,
        briefMessage: renderBriefMessage(
          params.brief,
          specialist,
          params.submittedBrief == null
            ? {
                pullRequestMetadata: {
                  title: params.review.prTitle,
                  body: params.review.prBody,
                },
              }
            : undefined,
        ),
        workspaceTools: params.workspaceTools,
        timeoutMs: Math.max(
          0,
          Math.min(
            params.review.cfg.reviewSpecialistTimeoutMs,
            params.review.timing.remainingModelMs(),
          ),
        ),
        shouldContinue: params.shouldContinue,
        signal: controller.signal,
        evidenceLedger: params.evidenceLedger,
        headSha: params.review.headSha,
        checkoutCoverage: params.review.workspace.getCoverage(),
        isPathInCheckout: (path) => params.review.workspace.isPathInCheckout(path),
        agentEvents: params.agentEvents ?? undefined,
      }),
    );
  }
  return pending;
}

async function runOrchestratorRecon(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly state: OrchestratedRunState;
  readonly session: PiSession | null;
  readonly isSessionRetired: () => boolean;
  readonly orchestratorUserContent: string;
  readonly getBrief: () => SpecialistBrief | null;
  readonly getValidationError: () => string | null;
  readonly clearValidationError: () => void;
  readonly sendWithRetry: OrchestratorFinalizeHooks["sendWithRetry"];
  readonly lastText: { value: string };
}): Promise<SpecialistBrief | null> {
  if (params.session) {
    const recon = await params.sendWithRetry(
      "recon",
      [params.orchestratorUserContent, ORCHESTRATOR_RECON_INSTRUCTION].join("\n\n"),
      { maxToolRounds: MAX_TOOL_ROUNDS },
    );
    if (recon.kind === "sent") params.lastText.value = recon.text;
    else params.state.judgment = "degraded";
  }

  const reconSession = params.session;
  if (params.getBrief() == null && !params.isSessionRetired() && reconSession) {
    await runValidationRepairLoop({
      rounds: VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () => params.getBrief() == null && !params.isSessionRetired(),
      getValidationError: () => params.getValidationError() ?? "No specialist brief was submitted.",
      clearValidationError: params.clearValidationError,
      repair: async (validationError) => {
        const repair = await params.sendWithRetry(
          "recon",
          [
            validationError,
            "Fix the brief and call submit_specialist_brief now. Do not use any other tools.",
          ].join("\n\n"),
        );
        if (repair.kind === "sent") params.lastText.value = repair.text;
        else params.state.judgment = "degraded";
      },
    });
  }

  const submittedBrief = params.getBrief();
  if (submittedBrief == null) {
    params.state.briefFallback = true;
    logWarn("review_brief_fallback", {
      owner: params.review.owner,
      repo: params.review.repo,
      pr: params.review.prNumber,
      sessionRetired: params.isSessionRetired(),
    });
  }
  return submittedBrief;
}

async function handleSpecialistCompletion(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly state: OrchestratedRunState;
  readonly session: PiSession | null;
  readonly isSessionRetired: () => boolean;
  readonly outcome: SpecialistOutcome;
  readonly incrementPublishAttempts: () => void;
  readonly lastText: { value: string };
  readonly abortSpecialists: () => void;
  readonly retireSession: () => Promise<void>;
  readonly recordOutcome: OrchestratorFinalizeHooks["recordOutcome"];
  readonly degradeReport: (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
    error?: unknown,
  ) => Promise<void>;
  readonly sendWithRetry: OrchestratorFinalizeHooks["sendWithRetry"];
  readonly applyPublishStop: () => Promise<boolean>;
  readonly writeTick: () => Promise<void>;
  readonly setSource: (source: SpecialistId) => void;
  readonly getLedger: ReturnType<typeof buildPublishThreadTool>["getLedger"];
}): Promise<void> {
  try {
    const gate = await params.review.gate.check();
    if (gate.kind !== "continue") {
      params.state.lifecycle = lifecycleFromRunGate(gate);
      params.abortSpecialists();
      await params.retireSession();
      return;
    }

    await params.recordOutcome(params.outcome);
    if (params.outcome.kind !== "report") return;
    const judgmentSession = params.session;
    if (params.state.judgment === "degraded" || params.isSessionRetired() || !judgmentSession) {
      await params.degradeReport(params.outcome);
      return;
    }

    params.setSource(params.outcome.specialist);
    const ledgerBefore = params.getLedger();
    params.incrementPublishAttempts();
    const judgment = await params.sendWithRetry("judgment", renderJudgmentTurn(params.outcome), {
      maxToolRounds: ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
    });
    if (judgment.kind === "failed") {
      await params.degradeReport(params.outcome, judgment.error);
      return;
    }
    params.lastText.value = judgment.text;
    if (await params.applyPublishStop()) return;
    params.state.specialists[params.outcome.specialist] = specialistDonePhase(
      ledgerBefore,
      params.getLedger(),
      params.outcome.specialist,
    );
    await params.writeTick();
  } catch (error) {
    await params.recordOutcome(params.outcome);
    if (params.outcome.kind === "report") {
      await params.degradeReport(params.outcome, error);
      return;
    }
    throw error;
  }
}

type OrchestratorFinalizeHooks = {
  readonly recordOutcome: (outcome: SpecialistOutcome) => Promise<void>;
  readonly degradeReport: (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
  ) => Promise<void>;
  readonly publishReportDeterministically: (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
  ) => Promise<void>;
  readonly publishFailureNotice: () => Promise<void>;
  readonly publishDeterministicSummary: () => Promise<void>;
  readonly writeTerminalTick: (
    stopped: Extract<OrchestratedRunState["lifecycle"], { kind: "stopped" }>,
  ) => Promise<void>;
  readonly markCompleteUnlessStopped: () => void;
  readonly applyPublishStop: () => Promise<boolean>;
  readonly sendWithRetry: (
    phase: "recon" | "judgment" | "synthesis",
    prompt: string,
    options?: Pick<PiSessionSendOptions, "maxToolRounds" | "deadlineMs">,
  ) => Promise<SendResult>;
  readonly acceptedFindings: () => ReturnType<
    ReturnType<typeof buildPublishThreadTool>["getLedger"]
  >["accepted"];
  readonly summaryStopPending: () => boolean;
  readonly incrementPublishAttempts: () => void;
  readonly currentPublishAttempts: () => number;
};

async function finalizeOrchestratedReview(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly state: OrchestratedRunState;
  readonly summaryState: PublishSummaryState;
  readonly session: PiSession | null;
  readonly isSessionRetired: () => boolean;
  readonly outcomes: readonly SpecialistOutcome[];
  readonly getFatalError: () => AppError | null;
  readonly lastText: { value: string };
  readonly hooks: OrchestratorFinalizeHooks;
}): Promise<void> {
  await recordRemainingSpecialistOutcomes({
    state: params.state,
    outcomes: params.outcomes,
    recordOutcome: params.hooks.recordOutcome,
    degradeReport: params.hooks.degradeReport,
  });
  const fatalError = params.getFatalError();
  if (fatalError != null) throw fatalError;

  if (params.state.lifecycle.kind === "stopped") {
    await params.hooks.writeTerminalTick(params.state.lifecycle);
    return;
  }
  if (params.state.lifecycle.kind === "finalizing") {
    await finalizeDeadlineReview({
      state: params.state,
      outcomes: params.outcomes,
      hooks: params.hooks,
    });
    return;
  }
  if (params.state.failedSpecialists.length === SPECIALIST_IDS.length) {
    await params.hooks.publishFailureNotice();
    params.state.lifecycle = { kind: "complete" };
    return;
  }
  if (params.state.judgment === "degraded" || params.isSessionRetired() || !params.session) {
    await params.hooks.publishDeterministicSummary();
    params.hooks.markCompleteUnlessStopped();
    return;
  }
  await finalizeSynthesisReview({
    review: params.review,
    state: params.state,
    summaryState: params.summaryState,
    isSessionRetired: params.isSessionRetired,
    lastText: params.lastText,
    hooks: params.hooks,
  });
}

async function recordRemainingSpecialistOutcomes(params: {
  readonly state: OrchestratedRunState;
  readonly outcomes: readonly SpecialistOutcome[];
  readonly recordOutcome: OrchestratorFinalizeHooks["recordOutcome"];
  readonly degradeReport: OrchestratorFinalizeHooks["degradeReport"];
}): Promise<void> {
  if (params.state.lifecycle.kind !== "running") return;
  for (const outcome of params.outcomes) {
    if (params.state.outcomes[outcome.specialist] != null) continue;
    await params.recordOutcome(outcome);
    if (outcome.kind === "report") await params.degradeReport(outcome);
  }
}

async function finalizeDeadlineReview(params: {
  readonly state: OrchestratedRunState;
  readonly outcomes: readonly SpecialistOutcome[];
  readonly hooks: OrchestratorFinalizeHooks;
}): Promise<void> {
  for (const outcome of params.outcomes) {
    if (params.state.outcomes[outcome.specialist] == null) {
      await params.hooks.recordOutcome(outcome);
    }
    if (
      outcome.kind === "report" &&
      params.state.specialists[outcome.specialist].phase === "running"
    ) {
      await params.hooks.publishReportDeterministically(outcome);
    }
  }
  params.state.judgment = "degraded";
  if (params.state.failedSpecialists.length === SPECIALIST_IDS.length) {
    await params.hooks.publishFailureNotice();
  } else {
    await params.hooks.publishDeterministicSummary();
  }
  params.hooks.markCompleteUnlessStopped();
}

async function finalizeSynthesisReview(params: {
  readonly review: OrchestratedReviewRunParams;
  readonly state: OrchestratedRunState;
  readonly summaryState: PublishSummaryState;
  readonly isSessionRetired: () => boolean;
  readonly lastText: { value: string };
  readonly hooks: OrchestratorFinalizeHooks;
}): Promise<void> {
  const { state, summaryState, hooks, lastText } = params;
  hooks.incrementPublishAttempts();
  const overviewPolicy = resolveDescriptionWritingPolicy(params.review.workspace.stats);
  const synthesisPrompt = renderSynthesisTurn({
    acceptedFindings: hooks.acceptedFindings(),
    partialSpecialists: state.failedSpecialists,
    outcomes: state.completionOrder.flatMap((specialist) => {
      const outcome = state.outcomes[specialist];
      return outcome ? [outcome] : [];
    }),
    overviewPolicy,
    fileCount: params.review.workspace.stats.fileCount,
    totalChanges: params.review.workspace.stats.totalChanges,
    truncated: params.review.workspace.stats.truncated,
  });
  const synthesis = await hooks.sendWithRetry("synthesis", synthesisPrompt);
  if (synthesis.kind === "sent") lastText.value = synthesis.text;
  else state.judgment = "degraded";
  await hooks.applyPublishStop();

  if (!summaryState.published && !params.isSessionRetired() && state.lifecycle.kind === "running") {
    await runValidationRepairLoop({
      rounds: VALIDATION_REPAIR_ROUNDS,
      shouldContinue: () =>
        !summaryState.published && !params.isSessionRetired() && state.lifecycle.kind === "running",
      getValidationError: () =>
        summaryState.lastValidationError ?? "The summary was not published.",
      clearValidationError: () => {
        summaryState.lastValidationError = null;
      },
      repair: async (validationError) => {
        const repair = await hooks.sendWithRetry(
          "synthesis",
          [validationError, "Fix the summary and call publish_summary now."].join("\n\n"),
        );
        if (repair.kind === "sent") lastText.value = repair.text;
        else state.judgment = "degraded";
        await hooks.applyPublishStop();
      },
    });
  }

  for (let round = 0; round < PUBLISH_RECOVERY_ROUNDS; round++) {
    if (summaryState.published || params.isSessionRetired() || state.lifecycle.kind !== "running") {
      break;
    }
    const recovery = await hooks.sendWithRetry(
      "synthesis",
      "Call publish_summary now with the complete final review. Do not reply with prose only.",
    );
    if (recovery.kind === "sent") lastText.value = recovery.text;
    else state.judgment = "degraded";
    await hooks.applyPublishStop();
  }

  if (hooks.summaryStopPending()) {
    state.summary = { kind: "pending" };
  } else if (summaryState.published) {
    state.summary = { kind: "published" };
  } else {
    // Model/session stayed healthy but never landed publish_summary after recovery.
    // Salvage accepted findings the same way as the degraded path instead of a hard fail.
    if (state.judgment !== "degraded" && !params.isSessionRetired()) {
      const lastFailure = snapshotReviewRunMetrics()?.lastFailure;
      logWarn("review_synthesis_publish_salvage", {
        owner: params.review.owner,
        repo: params.review.repo,
        pr: params.review.prNumber,
        publishAttempts: params.hooks.currentPublishAttempts(),
        judgment: state.judgment,
        lastValidationError: summaryState.lastValidationError,
        ...(lastFailure != null ? classifiedFailureLogFields(lastFailure) : {}),
      });
    }
    await hooks.publishDeterministicSummary();
  }
  hooks.markCompleteUnlessStopped();
}

export async function runOrchestratedPrReview(
  params: OrchestratedReviewRunParams,
): Promise<ReviewRunResult> {
  const reviewMode = params.mode ?? "review";
  initReviewRunMetrics({
    provider: params.cfg.piProvider,
    model: params.cfg.piModel,
    mode: reviewMode,
  });
  const setup = buildReviewRunSetup({
    cfg: params.cfg,
    prSurface: params.prSurface,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    headSha: params.headSha,
    userSupplement: params.userSupplement,
    trustedContext: params.trustedContext,
    workspace: params.workspace,
    pool: params.durability?.pool,
    codeIndexSnapshotId: params.codeIndexSnapshotId,
  });
  const phaseRef = createOrchestratorPhaseRef("recon");
  const briefTool = buildSpecialistBriefTool(phaseRef);
  const state = initialState();
  const agentEvents = resolveAgentEventsContext(params.cfg, params.durability);
  const resolveProgressCommentUrl = () =>
    resolveOrchestratorProgressCommentUrl({ review: params, reviewMode });
  const publishThread = buildPublishThreadTool({
    phaseRef,
    ctx: {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      hasDescriptionReviewMap: params.hasDescriptionReviewMap ?? false,
    },
    workItemId: params.workItemId,
    resolveProgressCommentUrl,
    prSurface: setup.prSurface,

    cachedDiffIndex: setup.cachedDiffIndex,
    repoPolicy: params.repoPolicy,
    sameRepo: params.sameRepo,
    boundPolicyJudge: createBoundPolicyJudge(params.cfg),
    readCheckoutFile: async (relativePath) => {
      try {
        const safePath = assertWorkspacePath(params.workspace.agentCwd, relativePath);
        return await readFile(safePath, "utf8");
      } catch {
        return undefined;
      }
    },
    recordPublishStep: params.recordPublishStep,
    operationIntent: orchestratorOperationIntent(params.recordPublishStep),
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    initialLedger: initialLedger(params),
    agentEvents: agentEvents ?? undefined,
    cfg: params.cfg,
    evidenceLedger: setup.evidenceLedger,
    checkoutCoverage: params.workspace.getCoverage(),
    isPathInCheckout: (path) => params.workspace.isPathInCheckout(path),
    pool: params.durability?.pool,
    installationId: params.durability?.installationId,
    findingHistoryCfg: params.cfg,
    crossPrSuppressionFingerprints: params.crossPrSuppressionFingerprints,
  });
  const summaryState = createPublishSummaryState({
    published: params.initialPublishState?.published,
  });
  const ciAuthor = createAgentCiSummaryAuthor(params.cfg);
  const publishSummary = buildPublishSummaryTool({
    phaseRef,
    cfg: params.cfg,
    ctx: {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      hasDescriptionReviewMap: params.hasDescriptionReviewMap ?? false,
    },
    prSurface: setup.prSurface,

    remainingFinalizationMs: params.timing.remainingTotalMs,
    mode: reviewMode,
    cachedDiffIndex: setup.cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    progressCommentIdHint: params.progressCommentIdHint,
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    ciAuthor,
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
  const createdSession = await createOrchestratorSession({
    cfg: params.cfg,
    cwd: params.cwd ?? params.workspace.agentCwd,
    tools: allTools,
    executors: allExecutors,
    durability: params.durability,
    deadlineMs: Math.min(params.timing.modelStopAtMs, params.timing.returnByMs),
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
  });
  let session = applyCreatedOrchestratorSession(state, createdSession);
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
    options?: Pick<PiSessionSendOptions, "maxToolRounds" | "deadlineMs">,
  ): Promise<SendResult> => {
    phaseRef.current = phase;
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
        state.lifecycle = lifecycleFromRunGate(gate);
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
        const sendPromise = session.send(prompt, {
          ...options,
          phase,
          checkpointId: `${session.role}:${phase}`,
        });
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
        const failure = classifyFailure(appError, { phase });
        recordClassifiedFailure(failure);
        logWarn("review_orchestrator_send_retry", {
          phase,
          attempt,
          ...errorLogFields(appError),
          ...classifiedFailureLogFields(failure),
        });
      }
    }
    const terminalError =
      firstError ??
      new AppError({
        code: "review.orchestrator_send_failed",
        message: "Orchestrator send failed twice",
        context: { phase },
      });

    // After primary retry budget, attempt one fallback-model restart when eligible.
    const primarySession = session;
    if (primarySession && !sessionRetired) {
      const fallback = classifyFallbackEligibility(terminalError);
      if (fallback.eligible) {
        try {
          const structuredState = primarySession.getStructuredState();
          const fallbackSession = await primarySession.restartWithFallback({
            checkpointId: `${primarySession.role}:${phase}`,
            structuredState,
          });
          session = fallbackSession;
          const sendPromise = fallbackSession.send(prompt, {
            ...options,
            phase,
            checkpointId: `${fallbackSession.role}:${phase}`,
          });
          const send = await settleBefore(
            sendPromise,
            Math.min(params.timing.modelStopAtMs, params.timing.returnByMs),
          );
          if (send.kind === "settled") {
            recordAgentTurnMetrics(send.value);
            logInfo("review_orchestrator_fallback_recovered", {
              phase,
              reason: fallback.reason,
            });
            return { kind: "sent", text: send.value.text };
          }
          void sendPromise.catch((fallbackSendError) => {
            logWarn("review_orchestrator_fallback_send_abandoned", {
              phase,
              reason: fallback.reason,
              settleKind: send.kind,
              ...errorLogFields(fallbackSendError),
            });
          });
        } catch (fallbackError) {
          logWarn("review_orchestrator_fallback_failed", {
            phase,
            reason: fallback.reason,
            ...errorLogFields(fallbackError),
          });
        }
      }
    }

    await retireSession();
    const failure = classifyFailure(terminalError, { phase });
    recordClassifiedFailure(failure);
    return {
      kind: "failed",
      error: terminalError,
    };
  };

  const snapshotSpecialists = (): OrchestratedRunState["specialists"] => ({
    correctness: state.specialists.correctness,
    security: state.specialists.security,
    quality: state.specialists.quality,
    tests: state.specialists.tests,
  });

  const writeTick = async (): Promise<void> => {
    const coordination = params.recordPublishStep?.summaryCommentCoordination;
    const revision = state.progressRevision;
    if (!coordination || revision === 0 || revision === 7) return;
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
        specialists: snapshotSpecialists(),
      },
      prSurface: setup.prSurface,

      hintCommentId: params.progressCommentIdHint,
    });
  };

  /** Edit queued stub → active roster as soon as the review worker starts agents. */
  const writeWorkerStartTick = async (): Promise<void> => {
    if (state.progressRevision !== 0) return;
    state.progressRevision = 1;
    await writeTick();
  };

  const markReconDoneAndTick = async (): Promise<void> => {
    state.recon = "done";
    for (const specialist of SPECIALIST_IDS) {
      state.specialists[specialist] = { phase: "running" };
    }
    // 0 → 1 if worker-start was skipped; 1 → 2 after worker-start (recon running).
    if (state.progressRevision === 0) {
      state.progressRevision = 1;
      await writeTick();
    } else if (state.progressRevision === 1) {
      state.progressRevision = 2;
      await writeTick();
    }
  };

  const writeTerminalTick = async (
    stopped: Extract<OrchestratedRunState["lifecycle"], { kind: "stopped" }>,
  ): Promise<void> => {
    const coordination = params.recordPublishStep?.summaryCommentCoordination;
    if (!coordination) return;
    state.progressRevision = 7;
    if (stopped.reason === "cancelled") {
      await writeCancelledProgressComment({
        pool: coordination.pool,
        workItemId: coordination.workItemId,
        resourceKey: coordination.resourceKey,
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        mode: reviewMode,
        attribution: stopped.attribution,
        prSurface: setup.prSurface,

        hintCommentId: params.progressCommentIdHint,
      });
      return;
    }
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
      progressRevision: 7,
      tickState: {
        kind: "terminal",
        reason: stopped.reason,
        recon: state.recon,
        specialists: snapshotSpecialists(),
      },
      prSurface: setup.prSurface,

      hintCommentId: params.progressCommentIdHint,
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
      const failure = classifyFailure(outcome.error, {
        phase: "specialist",
        toolName: outcome.specialist,
      });
      recordClassifiedFailure(failure);
      logWarn("review_specialist_failed", {
        specialist: outcome.specialist,
        durationMs: outcome.durationMs,
        ...errorLogFields(outcome.error),
        ...classifiedFailureLogFields(failure),
      });
      await writeTick();
    }
  };

  const publishReportDeterministically = async (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
  ): Promise<void> => {
    phaseRef.current = "judgment";
    publishThread.setSource(outcome.specialist);
    const ledgerBefore = publishThread.getLedger();

    publishAttempts += 1;
    const result = await publishThread.executor({ findings: outcome.report.findings });
    if (result.kind === "wrong_phase") {
      throw new AppError({
        code: result.code,
        message: result.error,
        context: { phase: result.phase, allowed: result.allowed },
      });
    }
    if (result.kind === "stopped") {
      await applyPublishStop();
      return;
    }
    state.specialists[outcome.specialist] = specialistDonePhase(
      ledgerBefore,
      publishThread.getLedger(),
      outcome.specialist,
    );
    await writeTick();
  };

  const degradeReport = async (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
    error?: unknown,
  ): Promise<void> => {
    state.judgment = "degraded";
    if (agentEvents) {
      const submittedCount = outcome.report.findings.length;
      safeEmitDecisionEvent(agentEvents, params.cfg, {
        specialist: outcome.specialist,
        phase: "judgment",
        submittedCount,
        acceptedCount: 0,
        rejectedCount: submittedCount,
        degraded: true,
      });
    }
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

    publishAttempts += 1;
    const result = await publishReviewSummaryOnly({
      cfg: params.cfg,
      ctx: {
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        headSha: params.headSha,
        hasDescriptionReviewMap: params.hasDescriptionReviewMap ?? false,
      },
      prSurface: setup.prSurface,

      remainingFinalizationMs: params.timing.remainingTotalMs,
      payload,
      ledger,
      mode: reviewMode,
      cachedDiffIndex: setup.cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      progressCommentIdHint: params.progressCommentIdHint,
      recordPublishStep: params.recordPublishStep,
      coverage: coverage(state),
      shouldAbortPublish: params.shouldAbortPublish,
      publishAbortState: params.publishAbortState,
      ciAuthor,
    });
    if (result.kind === "stopped") {
      state.lifecycle = { kind: "stopped", reason: result.reason };
      return;
    }
    summaryState.published = true;
    state.summary = { kind: "published" };
  };

  const publishFailureNotice = async (): Promise<void> => {
    const lastFailure = snapshotReviewRunMetrics()?.lastFailure ?? undefined;
    await publishReviewRunFailureNotice({
      cfg: params.cfg,
      setup,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      reviewMode,
      publishAttempts,
      ...(lastFailure != null ? { lastFailure } : {}),
    });
    state.summary = { kind: "failed" };
  };

  const lastTextRef = { value: lastText };
  try {
    await writeWorkerStartTick();

    const submittedBrief = await runOrchestratorRecon({
      review: params,
      state,
      session,
      isSessionRetired: () => sessionRetired,
      orchestratorUserContent: setup.orchestratorUserContent,
      getBrief: briefTool.getBrief,
      getValidationError: briefTool.getValidationError,
      clearValidationError: briefTool.clearValidationError,
      sendWithRetry,
      lastText: lastTextRef,
    });
    const brief = submittedBrief ?? fallbackBrief(params);
    await markReconDoneAndTick();

    const pending = startSpecialistRuns({
      review: params,
      brief,
      submittedBrief,
      workspaceTools: setup.workspaceTools,
      evidenceLedger: setup.evidenceLedger,
      shouldContinue: () => state.lifecycle.kind === "running",
      agentEvents,
      specialistControllers,
    });

    const outcomes = await pumpSpecialistCompletions({
      pending,
      shouldContinue: () => state.lifecycle.kind === "running",
      onOutcome: (outcome) =>
        handleSpecialistCompletion({
          review: params,
          state,
          session,
          isSessionRetired: () => sessionRetired,
          outcome,
          incrementPublishAttempts: () => {
            publishAttempts += 1;
          },
          lastText: lastTextRef,
          abortSpecialists,
          retireSession,
          recordOutcome,
          degradeReport,
          sendWithRetry,
          applyPublishStop,
          writeTick,
          setSource: publishThread.setSource,
          getLedger: publishThread.getLedger,
        }),
    });

    await finalizeOrchestratedReview({
      review: params,
      state,
      summaryState,
      session,
      isSessionRetired: () => sessionRetired,
      outcomes,
      getFatalError: () => fatalError,
      lastText: lastTextRef,
      hooks: {
        recordOutcome,
        degradeReport,
        publishReportDeterministically,
        publishFailureNotice,
        publishDeterministicSummary,
        writeTerminalTick,
        markCompleteUnlessStopped,
        applyPublishStop,
        sendWithRetry,
        acceptedFindings: () => publishThread.getLedger().accepted,
        summaryStopPending: () =>
          publishThread.getStopReason() != null || summaryState.stoppedReason != null,
        incrementPublishAttempts: () => {
          publishAttempts += 1;
        },
        currentPublishAttempts: () => publishAttempts,
      },
    });
    lastText = lastTextRef.value;
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

  return completeOrchestratedReviewResult({
    review: params,
    state,
    summaryState,
    publishAttempts,
    lastText,
    threadBatches: publishThread.getPublishedBatchCount(),
  });
}
