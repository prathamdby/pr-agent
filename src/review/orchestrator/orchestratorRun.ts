import type { AssistantMessage } from "@earendil-works/pi-ai";
import { reviewCheckDetailsUrl } from "../../agentWork/reviewCheckRun.js";
import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import { resolveAgentEventsContext } from "../../agent/runtime/agentEventSink.js";
import { assistantFromText } from "../../agentRun/sessionHelpers.js";
import { AppError, errorLogFields, toAppError } from "../../errors/appError.js";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.js";
import { logInfo, logWarn } from "../../evlog.js";
import {
  REVIEW_ACTIVE_BUDGET_MS,
  REVIEW_FINALIZATION_WINDOW_MS,
  REVIEW_RISK_PATH_PATTERNS,
  REVIEW_SPECIALIST_BUDGET_MS,
  TOKEN_FRESHNESS_BUFFER_MS,
} from "../../settings/index.js";
import { createAgentCiSummaryAuthor } from "../ci/authorCiSummary.js";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.js";
import type { ReviewPayload } from "../reviewSchema.js";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordClassifiedFailure,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
  type ReviewPhaseReceiptFields,
} from "../run/reviewRunMetrics.js";
import { buildReviewRunSetup } from "../run/reviewRunSetup.js";
import type { ReviewRunParams, ReviewRunResult } from "../run/reviewRunTypes.js";
import { renderBriefMessage, type SpecialistBrief } from "./briefTool.js";
import { pumpSpecialistCompletions } from "./completionPump.js";
import {
  createFindingLedger,
  SPECIALIST_IDS,
  specialistDonePhase,
  type OrchestratedRunState,
  type AcceptedPlacement,
  type ReviewBudgetReceipt,
  type ReviewCoverage,
  type ReviewRunGate,
  type ReviewRunTiming,
  type SpecialistId,
  type SpecialistOutcome,
} from "./orchestratorTypes.js";
import { buildPublishThreadTool } from "./publishThreadTool.js";
import { runSpecialist, type SpecialistTimeoutBudget } from "./specialistRun.js";
import { tickProgressComment } from "./stubTick.js";

const SPECIALIST_DURATION_FIELD = {
  correctness: "specialistCorrectnessMs",
  security: "specialistSecurityMs",
  quality: "specialistQualityMs",
  tests: "specialistTestsMs",
} as const satisfies Record<SpecialistId, keyof ReviewPhaseReceiptFields>;

function specialistTimeoutBudget(
  specialistTimeoutMs: number,
  remainingJobModelMs: number,
  remainingActiveModelMs: number,
): SpecialistTimeoutBudget {
  if (
    remainingActiveModelMs <= specialistTimeoutMs &&
    remainingActiveModelMs <= remainingJobModelMs
  ) {
    return {
      key: "model_window",
      limitMs: Math.max(0, remainingActiveModelMs),
    };
  }
  if (remainingJobModelMs < specialistTimeoutMs) {
    return { key: "model_window", limitMs: Math.max(0, remainingJobModelMs) };
  }
  return { key: "REVIEW_SPECIALIST_TIMEOUT_MS", limitMs: specialistTimeoutMs };
}

function phaseReceiptFromOutcome(outcome: SpecialistOutcome): ReviewPhaseReceiptFields {
  return { [SPECIALIST_DURATION_FIELD[outcome.specialist]]: outcome.durationMs };
}

export type OrchestratedReviewRunParams = ReviewRunParams & {
  readonly timing: ReviewRunTiming;
  readonly gate: ReviewRunGate;
  readonly prTitle: string;
  readonly prBody: string | null;
};

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
    budgetFailures: [],
    lifecycle: { kind: "running" },
    progressRevision: 0,
    summary: { kind: "pending" },
  };
}

function deterministicBrief(params: OrchestratedReviewRunParams): SpecialistBrief {
  const files = params.workspace.changedFiles.map((file) => file.path);
  const body = params.prBody?.trim();
  const prIntentText = [params.prTitle.trim(), body]
    .filter((part) => part != null && part.length > 0)
    .join("\n\n")
    .slice(0, 1900);
  const prIntent = wrapUntrustedBlock("pr_intent", prIntentText);
  const trustedContext = params.trustedContext?.trim() ?? "";
  const userSupplement = params.userSupplement?.trim();
  const sharedContext = [
    trustedContext,
    userSupplement ? wrapUntrustedBlock("user_supplement", userSupplement) : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const architectureNotes =
    sharedContext.length <= 6000
      ? sharedContext
      : `${sharedContext.slice(0, 2000)}\n\n[earlier context shortened]\n\n${sharedContext.slice(-3959)}`;
  const riskAreas = Object.entries(REVIEW_RISK_PATH_PATTERNS)
    .flatMap(([area, patterns]) => {
      const matches = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
      return matches.length === 0
        ? []
        : [
            {
              area,
              files: matches.slice(0, 20),
              reason: `Changed ${area} paths require priority inspection.`,
            },
          ];
    })
    .slice(0, 12);
  return {
    prIntent,
    architectureNotes:
      architectureNotes || "No additional repository architecture or policy context was provided.",
    riskAreas,
    fileMap: files.length > 0 ? files.join("\n").slice(0, 6000) : "No changed files were listed.",
    specialistFocus: {
      correctness:
        "Prioritize behavior, state transitions, error handling, and high-stakes changed paths.",
      security: "Prioritize changed trust boundaries, authorization, and sensitive data handling.",
      quality:
        "Prioritize material maintainability regressions, module ownership, and avoidable complexity.",
      tests: "Prioritize regression coverage for changed critical and failure paths.",
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

function budgetReceiptFromError(error: AppError): ReviewBudgetReceipt | undefined {
  const { budgetKey, limitMs, usedMs } = error.context;
  if (
    (budgetKey === "REVIEW_ACTIVE_BUDGET_MS" ||
      budgetKey === "REVIEW_SPECIALIST_TIMEOUT_MS" ||
      budgetKey === "model_window") &&
    typeof limitMs === "number" &&
    Number.isFinite(limitMs) &&
    typeof usedMs === "number" &&
    Number.isFinite(usedMs)
  ) {
    return { budgetKey, limitMs, usedMs };
  }
  return undefined;
}

function renderCoveragePaths(paths: readonly string[]): string {
  if (paths.length === 0) return "(none)";
  const shown = paths.slice(0, 20);
  const remaining = paths.length - shown.length;
  return `${shown.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

function coverage(
  state: OrchestratedRunState,
  scope: {
    readonly inspectedPaths: readonly string[];
    readonly changedPaths: readonly string[];
    readonly skippedPaths: readonly string[];
  },
): ReviewCoverage {
  const inspectedPathCount = scope.inspectedPaths.length;
  const changedPathCount = scope.changedPaths.length;
  const failed = [...state.failedSpecialists];
  const names = failed.join(", ");
  const budgetReceipts: ReviewBudgetReceipt[] = [];
  for (const specialist of failed) {
    const outcome = state.outcomes[specialist];
    if (outcome?.kind !== "error") continue;
    const receipt = budgetReceiptFromError(outcome.error);
    if (receipt != null) budgetReceipts.push(receipt);
  }
  if (state.lifecycle.kind === "finalizing" && state.lifecycle.budget != null) {
    budgetReceipts.push(state.lifecycle.budget);
  }
  budgetReceipts.push(...state.budgetFailures);
  if (
    failed.length === 0 &&
    budgetReceipts.length === 0 &&
    inspectedPathCount >= changedPathCount
  ) {
    return { kind: "full" };
  }
  if (failed.length === SPECIALIST_IDS.length && budgetReceipts.length === 0) {
    return { kind: "none", failed };
  }
  const uniqueBudgetReceipts = new Map<string, ReviewBudgetReceipt>();
  for (const receipt of budgetReceipts) {
    const key = `${receipt.budgetKey}:${receipt.limitMs}`;
    const current = uniqueBudgetReceipts.get(key);
    if (current == null || receipt.usedMs > current.usedMs) {
      uniqueBudgetReceipts.set(key, receipt);
    }
  }
  const budgetNote = [...uniqueBudgetReceipts.values()]
    .map(
      (receipt) =>
        `${receipt.budgetKey} enforced (limit ${receipt.limitMs} ms, used ${receipt.usedMs} ms).`,
    )
    .join(" ");
  return {
    kind: "partial",
    failed,
    note: [
      failed.length === 0
        ? budgetReceipts.length > 0
          ? "Coverage partial: the active review budget ended the run."
          : "Coverage partial: not every changed path was inspected."
        : `Coverage partial: ${names} specialist${failed.length === 1 ? "" : "s"} failed; per-specialist read scope is unavailable.`,
      budgetNote,
      `Aggregate inspected coverage: ${inspectedPathCount} of ${changedPathCount} changed paths; ${scope.skippedPaths.length} skipped.`,
      `Inspected paths: ${renderCoveragePaths(scope.inspectedPaths)}. Skipped paths: ${renderCoveragePaths(scope.skippedPaths)}.`,
    ]
      .filter((part) => part.length > 0)
      .join(" "),
  };
}

function hasBudgetFailure(state: OrchestratedRunState): boolean {
  return Object.values(state.outcomes).some(
    (outcome) => outcome?.kind === "error" && budgetReceiptFromError(outcome.error) != null,
  );
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
  readonly findings: ReviewPayload["findings"];
  readonly accepted: readonly AcceptedPlacement[];
}): ReviewPayload {
  const securityTitles = [
    ...new Set(
      params.accepted.flatMap((accepted) => {
        const finding = accepted.placement.finding;
        return accepted.source === "security" || finding.category === "security"
          ? [finding.title]
          : [];
      }),
    ),
  ];
  return {
    prCharacter: "The orchestrated review completed.",
    findings: [...params.findings],
    estimatedEffort: params.findings.length === 0 ? 1 : Math.min(5, params.findings.length + 1),
    relevantTests: "partial",
    securityConcerns: securityTitles.length === 0 ? null : securityTitles.join("; ").slice(0, 4000),
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
  const orchestratedStartedAtMs = Date.now();
  initReviewRunMetrics({
    provider: params.cfg.piProvider,
    model: params.cfg.piModel,
    mode: reviewMode,
    activeStartedAtMs: orchestratedStartedAtMs,
    activeBudgetMs: REVIEW_ACTIVE_BUDGET_MS,
  });
  const activeReturnByMs = orchestratedStartedAtMs + REVIEW_ACTIVE_BUDGET_MS;
  const activeModelStopAtMs = activeReturnByMs - REVIEW_FINALIZATION_WINDOW_MS;
  const setup = buildReviewRunSetup({
    ...params,
    pool: params.durability?.pool,
    codeIndexSnapshotId: params.codeIndexSnapshotId,
    tokenTtlMs:
      typeof params.tokenTtlMs === "number" &&
      Number.isFinite(params.tokenTtlMs) &&
      params.tokenTtlMs > 0
        ? params.tokenTtlMs
        : TOKEN_FRESHNESS_BUFFER_MS,
  });
  const coverageScope = () => {
    const changedPathSet = new Set(params.workspace.changedFiles.map((file) => file.path));
    const inspectedPathSet = new Set(
      setup.evidenceLedger
        .snapshot()
        .map((read) => read.path)
        .filter((path) => changedPathSet.has(path)),
    );
    const changedPaths = [...changedPathSet].toSorted();
    const inspectedPaths = [...inspectedPathSet].toSorted();
    return {
      inspectedPaths,
      changedPaths,
      skippedPaths: changedPaths.filter((path) => !inspectedPathSet.has(path)),
    };
  };
  const state = initialState();
  const agentEvents = resolveAgentEventsContext(params.cfg, params.durability);
  const publishThread = buildPublishThreadTool({
    ctx: {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      hasDescriptionReviewMap: params.hasDescriptionReviewMap ?? false,
    },
    workItemId: params.workItemId,
    progressCommentUrl: reviewCheckDetailsUrl(
      params.owner,
      params.repo,
      params.prNumber,
      params.summaryCommentIdHint,
    ),
    getToken: setup.getToken,
    getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
    refreshLiveAuth: setup.refreshLiveAuth,
    cachedDiffIndex: setup.cachedDiffIndex,
    recordPublishStep: params.recordPublishStep,
    operationIntent: params.recordPublishStep?.summaryCommentCoordination
      ? {
          client: params.recordPublishStep.summaryCommentCoordination.pool,
          workItemId: params.recordPublishStep.summaryCommentCoordination.workItemId,
          resourceKey: params.recordPublishStep.summaryCommentCoordination.resourceKey,
        }
      : undefined,
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
  let summaryPublished = params.initialPublishState?.published ?? false;
  const ciAuthor = createAgentCiSummaryAuthor(params.cfg);
  const specialistControllers = new Map<SpecialistId, AbortController>();
  let budgetTick: Promise<void> = Promise.resolve();
  let publishAttempts = 0;
  let fatalError: AppError | null = null;
  let finalizationMs = 0;

  const abortSpecialists = (): void => {
    for (const controller of specialistControllers.values()) controller.abort();
  };

  const activateActiveBudgetFailure = (): void => {
    if (
      state.lifecycle.kind === "stopped" ||
      state.lifecycle.kind === "complete" ||
      (state.lifecycle.kind === "finalizing" && state.lifecycle.reason === "active_budget")
    ) {
      return;
    }
    const budget: ReviewBudgetReceipt = {
      budgetKey: "REVIEW_ACTIVE_BUDGET_MS",
      limitMs: REVIEW_ACTIVE_BUDGET_MS,
      usedMs: Math.max(0, Date.now() - orchestratedStartedAtMs),
    };
    state.lifecycle = { kind: "finalizing", reason: "active_budget", budget };
    state.budgetFailures.push(budget);
    abortSpecialists();
    budgetTick = writeTick();
  };

  const activateModelWindowFailure = (limitMs: number): void => {
    if (state.lifecycle.kind !== "running") return;
    const budget: ReviewBudgetReceipt = {
      budgetKey: "model_window",
      limitMs: Math.max(0, limitMs),
      usedMs: Math.max(0, Date.now() - orchestratedStartedAtMs),
    };
    state.lifecycle = { kind: "finalizing", reason: "deadline", budget };
    state.budgetFailures.push(budget);
    abortSpecialists();
    budgetTick = writeTick();
  };

  const activeBudgetTimer = setTimeout(
    activateActiveBudgetFailure,
    Math.max(0, activeReturnByMs - Date.now()),
  );
  const finalizationTimer = setTimeout(
    () => {
      if (state.completionOrder.length === SPECIALIST_IDS.length) return;
      activateModelWindowFailure(activeModelStopAtMs - orchestratedStartedAtMs);
    },
    Math.max(0, activeModelStopAtMs - Date.now()),
  );

  const markCompleteUnlessStopped = (): void => {
    if (state.lifecycle.kind !== "stopped") state.lifecycle = { kind: "complete" };
  };

  const applyPublishStop = (): boolean => {
    const reason = publishThread.getStopReason();
    if (!reason) return false;
    state.lifecycle = { kind: "stopped", reason };
    abortSpecialists();
    return true;
  };

  async function writeTick(): Promise<void> {
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
        ...(state.lifecycle.kind === "finalizing" && state.lifecycle.budget != null
          ? { budget: state.lifecycle.budget }
          : {}),
      },
      getToken: setup.getToken,
      getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
      refreshLiveAuth: setup.refreshLiveAuth,
      hintCommentId: params.summaryCommentIdHint,
    });
  }

  const markReconDoneAndTick = async (): Promise<void> => {
    state.recon = "done";
    setReviewRunMetricFields({
      reconMs: Math.max(0, Date.now() - orchestratedStartedAtMs),
    });
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
      tickState: {
        kind: "terminal",
        reason,
        recon: state.recon,
        specialists: state.specialists,
      },
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
    setReviewRunMetricFields(phaseReceiptFromOutcome(outcome));
    if (outcome.kind === "empty") {
      state.specialists[outcome.specialist] = { phase: "no_findings" };
      await writeTick();
    } else if (outcome.kind === "error") {
      const budget =
        state.lifecycle.kind === "finalizing" && state.lifecycle.reason === "active_budget"
          ? state.lifecycle.budget
          : budgetReceiptFromError(outcome.error);
      state.specialists[outcome.specialist] =
        budget == null ? { phase: "failed" } : { phase: "failed", budget };
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
    publishThread.setSource(outcome.specialist);
    const ledgerBefore = publishThread.getLedger();
    await setup.refreshLiveAuth();
    publishAttempts += 1;
    const result = await publishThread.executor({ findings: outcome.report.findings });
    if (result.kind === "stopped") {
      applyPublishStop();
      return;
    }
    state.specialists[outcome.specialist] = specialistDonePhase(
      ledgerBefore,
      publishThread.getLedger(),
      outcome.specialist,
    );
    await writeTick();
  };

  const publishDeterministicSummary = async (): Promise<void> => {
    const ledger = publishThread.getLedger();
    const payload = deterministicPayload({
      findings: ledger.accepted.map((accepted) => accepted.placement.finding),
      accepted: ledger.accepted,
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
        hasDescriptionReviewMap: params.hasDescriptionReviewMap ?? false,
      },
      getToken: setup.getToken,
      getTokenExpiresAtTs: setup.getTokenExpiresAtTs,
      refreshLiveAuth: setup.refreshLiveAuth,
      remainingFinalizationMs: (now = Date.now()) =>
        Math.min(params.timing.remainingTotalMs(now), Math.max(0, activeReturnByMs - now)),
      payload,
      ledger,
      mode: reviewMode,
      cachedDiffIndex: setup.cachedDiffIndex,
      shouldLinkToSummary: params.shouldLinkToSummary,
      summaryCommentIdHint: params.summaryCommentIdHint,
      recordPublishStep: params.recordPublishStep,
      coverage: coverage(state, coverageScope()),
      getCoverage: () => coverage(state, coverageScope()),
      shouldAbortPublish: params.shouldAbortPublish,
      publishAbortState: params.publishAbortState,
      ciAuthor,
    });
    if (result.kind === "stopped") {
      state.lifecycle = { kind: "stopped", reason: result.reason };
      return;
    }
    summaryPublished = true;
    state.summary = { kind: "published" };
  };

  const publishFailureNotice = async (): Promise<void> => {
    await setup.refreshLiveAuth();
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

  try {
    const brief = deterministicBrief(params);
    await markReconDoneAndTick();

    const pending = new Map<SpecialistId, Promise<SpecialistOutcome>>();
    const specialistsSpawnedAtMs = Date.now();
    for (const specialist of SPECIALIST_IDS) {
      const controller = new AbortController();
      specialistControllers.set(specialist, controller);
      const remainingJobModelMs = params.timing.remainingModelMs();
      const remainingActiveModelMs = Math.max(0, activeModelStopAtMs - Date.now());
      const remainingModelMs = Math.min(remainingJobModelMs, remainingActiveModelMs);
      const specialistTimeoutMs = Math.min(
        params.cfg.reviewSpecialistTimeoutMs,
        REVIEW_SPECIALIST_BUDGET_MS,
      );
      const timeoutMs = Math.max(0, Math.min(specialistTimeoutMs, remainingModelMs));
      pending.set(
        specialist,
        runSpecialist({
          cfg: params.cfg,
          cwd: params.cwd ?? params.workspace.agentCwd,
          specialist,
          briefMessage: renderBriefMessage(brief, specialist),
          workspaceTools: setup.workspaceTools,
          timeoutMs,
          timeoutBudget: specialistTimeoutBudget(
            specialistTimeoutMs,
            remainingJobModelMs,
            remainingActiveModelMs,
          ),
          shouldContinue: () => state.lifecycle.kind === "running",
          signal: controller.signal,
          evidenceLedger: setup.evidenceLedger,
          headSha: params.headSha,
          checkoutCoverage: params.workspace.getCoverage(),
          isPathInCheckout: (path) => params.workspace.isPathInCheckout(path),
          agentEvents: agentEvents ?? undefined,
        }),
      );
    }

    const outcomes = await pumpSpecialistCompletions({
      pending,
      shouldContinue: () => state.lifecycle.kind === "running",
      onOutcome: async (outcome) => {
        let gate: Awaited<ReturnType<typeof params.gate.check>>;
        try {
          gate = await params.gate.check();
        } catch {
          await recordOutcome(outcome);
          if (outcome.kind === "report") await publishReportDeterministically(outcome);
          return;
        }
        if (gate.kind !== "continue") {
          if (gate.kind === "stop") {
            state.lifecycle = { kind: "stopped", reason: gate.reason };
            abortSpecialists();
          } else {
            activateModelWindowFailure(params.timing.modelStopAtMs - orchestratedStartedAtMs);
          }
          return;
        }

        await recordOutcome(outcome);
        if (outcome.kind === "report") {
          try {
            await publishReportDeterministically(outcome);
          } catch (error) {
            fatalError = toAppError(error, {
              code: "review.deterministic_finding_publish_failed",
              context: { specialist: outcome.specialist },
            });
            abortSpecialists();
          }
        }
      },
    });

    if (state.lifecycle.kind === "running") {
      for (const outcome of outcomes) {
        if (state.outcomes[outcome.specialist] != null) continue;
        await recordOutcome(outcome);
        if (outcome.kind === "report") await publishReportDeterministically(outcome);
      }
    }

    setReviewRunMetricFields({
      specialistsParallelMs: Math.max(0, Date.now() - specialistsSpawnedAtMs),
    });
    const synthesisStartedAtMs = Date.now();

    if (fatalError != null) throw fatalError;

    if (state.lifecycle.kind === "stopped") {
      await writeTerminalTick(state.lifecycle.reason);
    } else {
      for (const outcome of outcomes) {
        if (state.outcomes[outcome.specialist] == null) await recordOutcome(outcome);
        if (
          outcome.kind === "report" &&
          state.specialists[outcome.specialist].phase === "running"
        ) {
          await publishReportDeterministically(outcome);
        }
      }
      if (Date.now() >= activeReturnByMs) activateActiveBudgetFailure();
      if (
        state.failedSpecialists.length === SPECIALIST_IDS.length &&
        !hasBudgetFailure(state) &&
        state.budgetFailures.length === 0
      ) {
        await publishFailureNotice();
      } else {
        await publishDeterministicSummary();
      }
      if (Date.now() >= activeReturnByMs) activateActiveBudgetFailure();
      await budgetTick;
      markCompleteUnlessStopped();
    }

    finalizationMs = Math.max(0, Date.now() - synthesisStartedAtMs);
    setReviewRunMetricFields({ synthesisMs: finalizationMs });
  } catch (error) {
    abortSpecialists();
    throw toAppError(error, {
      code: "review.orchestrator_run_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
  } finally {
    clearTimeout(finalizationTimer);
    clearTimeout(activeBudgetTimer);
  }

  const specialistOutcomes: Record<string, number> = {};
  for (const outcome of Object.values(state.outcomes)) {
    if (!outcome) continue;
    specialistOutcomes[outcome.kind] = (specialistOutcomes[outcome.kind] ?? 0) + 1;
  }
  const finalScope = coverageScope();
  const timedOut =
    Object.values(state.outcomes).some(
      (outcome) => outcome?.kind === "error" && budgetReceiptFromError(outcome.error) != null,
    ) ||
    Object.values(state.specialists).some(
      (phase) => phase.phase === "failed" && phase.budget != null,
    ) ||
    state.budgetFailures.length > 0;
  setReviewRunMetricFields({
    published: summaryPublished,
    publishAttempts,
    specialistOutcomes,
    threadBatches: publishThread.getPublishedBatchCount(),
    finalizationMs,
    timedOut,
    partialCoverage: coverage(state, finalScope).kind === "partial",
    promptProfile: "normal",
    inspectedPathCount: finalScope.inspectedPaths.length,
    changedPathCount: finalScope.changedPaths.length,
  });
  logReviewRunCompleted({
    judgment: "deterministic",
    lifecycle: state.lifecycle.kind,
  });
  logInfo("review_orchestrator_completed", {
    owner: params.owner,
    repo: params.repo,
    pr: params.prNumber,
    completionOrder: state.completionOrder,
    judgment: "deterministic",
  });

  const lastAssistant: AssistantMessage = assistantFromText(params.cfg, "", params.cfg.piProvider);
  const lastFailure = snapshotReviewRunMetrics()?.lastFailure ?? undefined;
  return {
    lastAssistant,
    published: summaryPublished,
    publishAttempts,
    publishSuperseded: state.lifecycle.kind === "stopped",
    ...(lastFailure != null ? { lastFailure } : {}),
  };
}
