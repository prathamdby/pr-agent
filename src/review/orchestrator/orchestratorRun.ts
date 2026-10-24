import { slimAcceptedFindings } from "./slimAcceptedFindings.ts";
import { readFile } from "node:fs/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { reviewCheckDetailsUrl } from "../../agentWork/reviewVerdict.ts";
import { getSummaryCommentGithubId } from "../../agentWork/publishRecordRepository.ts";
import type { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.ts";
import { combineAbortSignals, type TurnEnd } from "../../agent/providers/interface.ts";
import {
  isCancelAbortError,
  isProviderRefusalError,
} from "../../agent/providers/providerErrors.ts";
import {
  resolveAgentEventsContext,
  safeEmitDecisionEvent,
} from "../../agent/runtime/agentEventSink.ts";
import type { PiSession, PiSessionSendOptions } from "../../agent/runtime/types.ts";
import { assistantFromText, runValidationRepairLoop } from "../../agent/runtime/featureAgent.ts";
import { escalatedToolRounds, type EscalationPlan } from "../../agentWork/retryPolicy.ts";
import { prResourceKey } from "../../agentWork/types.ts";
import { AppError, errorLogFields, toAppError } from "../../errors/appError.ts";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.ts";
import { logInfo, logWarn } from "../../evlog.ts";
import {
  MAX_TOOL_ROUNDS,
  ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
  PUBLISH_RECOVERY_ROUNDS,
  REVIEW_SUMMARY_SENTINEL,
  SUBMIT_ONLY_MAX_TOOL_ROUNDS,
  VALIDATION_REPAIR_ROUNDS,
} from "../../settings/index.ts";
import { assertWorkspacePath } from "../../prWorkspace/repositoryReader.ts";
import { createBoundPolicyJudge } from "../publish/boundPolicyJudge.ts";
import { publishReviewSummaryOnly } from "../publish/publishSummaryOnly.ts";
import { recordedPolicyBaseSha, reviewPolicySummaryAlert } from "../policySnapshotUse.ts";
import { createReviewPublishSession } from "../publish/reviewPublishSession.ts";
import { reviewPayloadFromFindings } from "../reviewSchema.ts";
import { publishReviewRunFailureNotice } from "../run/reviewRunFallback.ts";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordAgentTurnMetrics,
  recordClassifiedFailure,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "../run/reviewRunMetrics.ts";
import { buildReviewRunSetup } from "../run/reviewRunSetup.ts";
import type { ReviewRunParams, ReviewRunResult } from "../run/reviewRunTypes.ts";
import { buildSpecialistBriefTool, type SpecialistBrief } from "./briefTool.ts";
import {
  appendTrustedSpecialistContext,
  renderBriefMessage,
  orchestratorSystemPrompt,
  renderJudgmentTurn,
  renderSynthesisTurn,
  ORCHESTRATOR_MISSING_BRIEF_ERROR,
  ORCHESTRATOR_MISSING_SUMMARY_ERROR,
  ORCHESTRATOR_RECOVER_SUMMARY_INSTRUCTION,
  renderOrchestratorRecoveryBootstrap,
  renderOrchestratorReconTurn,
  renderOrchestratorBriefRepair,
  renderOrchestratorSummaryRepair,
} from "../../prompts/orchestrator/prompt.ts";
import { pumpSpecialistCompletions } from "./completionPump.ts";
import {
  countAcceptedForSource,
  createFindingLedger,
  ledgerFindings,
  SPECIALIST_IDS,
  specialistDonePhase,
  type FindingLedger,
  type OrchestratedRunState,
  type ReviewCoverage,
  type ReviewRunGate,
  type ReviewRunGateResult,
  type ReviewRunTiming,
  type SpecialistId,
  type SpecialistOutcome,
} from "./orchestratorTypes.ts";
import { createOrchestratorPhaseRef } from "./phaseToolPolicy.ts";
import { buildPublishSummaryTool, createPublishSummaryState } from "./publishSummaryTool.ts";
import { buildPublishThreadTool } from "./publishThreadTool.ts";
import { buildDeclareDuplicateTool } from "./declareDuplicateTool.ts";
import { judgmentInventory } from "./judgmentInventory.ts";
import {
  loadFindingInventoryOrUnavailable,
  openReviewThreads,
  type AcceptedOpenThread,
  type FindingInventory,
} from "../findingIdentity/findingInventory.ts";
import { buildFindingView, type FindingCheck } from "../findingIdentity/findingLifecycle.ts";
import { nextStep, type ReviewStep, type ReviewStepFacts } from "./runStep.ts";
import { runSpecialist } from "./specialistRun.ts";
import { tickProgressComment, writeCancelledProgressComment } from "./stubTick.ts";
import { createGovernedReviewEvidenceReader } from "../../agent/tools/workspaceToolset.ts";
import {
  OPENED_PATH_MAX_CHARS,
  revalidateEvidenceDescriptors,
  unreadChangedFilesNote,
  unreadChangedPaths,
} from "../findings/evidenceLedger.ts";
import { UNREAD_COVERAGE_PATH_LIMIT } from "../recovery/reviewRecoverySchema.ts";
import { assertFindingsHaveEvidence } from "../findings/evidenceValidator.ts";
import { evidenceForCachedFindings } from "../recovery/reviewCachedOutputs.ts";

function ownVerdictPublishParams(params: ReviewRunParams): {
  readonly workItemId?: string;
  readonly resourceKey: string;
  readonly leaseEpoch?: number | null;
} {
  const coordination = params.recordPublishStep?.summaryCommentCoordination;
  return {
    workItemId: coordination?.workItemId ?? params.workItemId ?? params.sessionContext?.workItemId,
    resourceKey:
      coordination?.resourceKey ?? prResourceKey(params.owner, params.repo, params.prNumber),
    leaseEpoch: coordination?.leaseEpoch,
  };
}

export type OrchestratedReviewRunParams = ReviewRunParams & {
  readonly timing: ReviewRunTiming;
  readonly gate: ReviewRunGate;
  readonly prTitle: string;
  readonly prBody: string | null;
  readonly escalation?: EscalationPlan;
  readonly createSession: typeof createFeaturePiSession;
};

type SendResult =
  | { readonly kind: "sent"; readonly text: string; readonly end: TurnEnd }
  | { readonly kind: "failed"; readonly error: AppError };

type JudgmentDegradeCause =
  | { readonly reason: "judgment_failed"; readonly error: unknown }
  | { readonly reason: "judgment_unpublished"; readonly turnEnd: TurnEnd }
  | { readonly reason: "judgment_unavailable" };

type DeadlineResult<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "deadline" }
  | { readonly kind: "aborted" };

async function settleBefore<T>(
  promise: Promise<T>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<DeadlineResult<T>> {
  if (signal?.aborted) return { kind: "aborted" };
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
  let removeAbort: (() => void) | undefined;
  const aborted =
    signal == null
      ? undefined
      : new Promise<DeadlineResult<T>>((resolve) => {
          const onAbort = () => resolve({ kind: "aborted" });
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        });
  const result = await Promise.race(
    aborted == null ? [settled, deadline] : [settled, deadline, aborted],
  );
  if (timer) clearTimeout(timer);
  removeAbort?.();
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
    unjudgedSpecialists: [],
    briefFallback: false,
    judgment: "model",
    lifecycle: { kind: "running" },
    progressRevision: 0,
    summary: { kind: "pending" },
  };
}

function fallbackBrief(params: OrchestratedReviewRunParams): SpecialistBrief {
  const files = params.workspace.reader.changedFiles.map((file) => file.path);
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

function loadReviewFindingInventory(
  params: OrchestratedReviewRunParams,
): Promise<FindingInventory> {
  const renames = new Map<string, string>();
  const deletedPaths = new Set<string>();
  for (const file of params.workspace.reader.changedFiles) {
    if (file.status === "renamed" && file.oldPath != null) renames.set(file.oldPath, file.path);
    if (file.status === "deleted") deletedPaths.add(file.path);
  }
  return loadFindingInventoryOrUnavailable(params.prSurface, { renames, deletedPaths });
}

export function reviewRunCoverage(
  failedSpecialists: readonly SpecialistId[],
  unreadPaths: readonly string[],
  unjudgedSpecialists: readonly SpecialistId[] = [],
): ReviewCoverage {
  const failed = [...failedSpecialists];
  if (failed.length === SPECIALIST_IDS.length) return { kind: "none", failed };
  const paths: string[] = [];
  for (const path of unreadPaths) {
    const bounded = path.slice(0, OPENED_PATH_MAX_CHARS);
    if (bounded.length === 0) continue;
    paths.push(bounded);
    if (paths.length === UNREAD_COVERAGE_PATH_LIMIT) break;
  }
  const unjudged = [...unjudgedSpecialists];
  if (failed.length === 0 && paths.length === 0 && unjudged.length === 0) return { kind: "full" };
  const sentences: string[] = [];
  if (failed.length > 0) {
    const names = failed.join(", ");
    sentences.push(
      `Coverage partial: ${names} specialist${failed.length === 1 ? "" : "s"} failed.`,
    );
  }
  if (paths.length > 0) sentences.push(unreadChangedFilesNote(unreadPaths));
  if (unjudged.length > 0) sentences.push(`Not judged: ${unjudged.join(", ")}.`);
  return {
    kind: "partial",
    note: sentences.join(" "),
    ...(failed.length > 0 ? { failed } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(unjudged.length > 0 ? { unjudged } : {}),
  };
}

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

function acceptedOpenThreads(ledger: FindingLedger): AcceptedOpenThread[] {
  return ledger.accepted.flatMap((accepted) =>
    accepted.kind === "summary_only"
      ? []
      : [
          {
            id: accepted.findingId,
            path: accepted.placement.finding.file,
            startLine: accepted.placement.finding.startLine,
            endLine: accepted.placement.finding.endLine,
            title: accepted.placement.finding.title,
            detail: accepted.placement.finding.detail,
            severity: accepted.placement.finding.severity,
            lens: accepted.source,
          },
        ],
  );
}

export async function runOrchestratedPrReview(
  params: OrchestratedReviewRunParams,
): Promise<ReviewRunResult> {
  const reviewMode = params.mode ?? "review";
  initReviewRunMetrics({
    provider: params.cfg.models.provider,
    model: params.cfg.models.model,
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
    ...(params.workItemId != null || params.sessionContext?.workItemId != null
      ? {
          workItemId: params.workItemId ?? params.sessionContext?.workItemId,
        }
      : {}),
  });
  const unreadPathsNow = () =>
    unreadChangedPaths({
      ledger: setup.evidenceLedger,
      changedFiles: params.workspace.reader.changedFiles,
      isPathInCheckout: (path) => params.workspace.reader.isPathInCheckout(path),
    });
  const publishCtx = {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    headSha: params.headSha,
    hasDescriptionReviewMap: params.hasDescriptionReviewMap ?? false,
  };
  const sessionCwd = params.cwd ?? params.workspace.agentCwd;
  const phaseRef = createOrchestratorPhaseRef("recon");
  const recovery = params.recovery;
  const readEvidence = createGovernedReviewEvidenceReader(params.workspace.reader, params.headSha);
  const mustRestoreOpens = params.workspace.reader.changedFiles.some(
    (file) => file.status !== "deleted" && params.workspace.reader.isPathInCheckout(file.path),
  );
  const cachedBriefEnvelope = await recovery?.load("brief");
  let cachedBrief =
    cachedBriefEnvelope?.artifact.kind === "brief" ? cachedBriefEnvelope.artifact.brief : undefined;
  if (cachedBriefEnvelope?.artifact.kind === "brief" && cachedBriefEnvelope.artifact.openedPaths) {
    for (const path of cachedBriefEnvelope.artifact.openedPaths) {
      setup.evidenceLedger.noteOpened(path);
    }
  } else if (mustRestoreOpens && cachedBrief != null) {
    cachedBrief = undefined;
  }
  const cachedReports = new Map<SpecialistId, SpecialistOutcome>();
  if (recovery) {
    for (const specialist of SPECIALIST_IDS) {
      const envelope = await recovery.load(`report/${specialist}`);
      if (envelope?.artifact.kind !== "report") continue;
      const artifact = envelope.artifact;
      if (artifact.openedPaths) {
        for (const path of artifact.openedPaths) setup.evidenceLedger.noteOpened(path);
      } else if (mustRestoreOpens) {
        recovery.discardEvidenceCache();
        continue;
      }
      if (
        !(await revalidateEvidenceDescriptors(
          setup.evidenceLedger,
          artifact.evidence,
          readEvidence,
        ))
      ) {
        recovery.discardEvidenceCache();
        continue;
      }
      const validated = assertFindingsHaveEvidence(
        artifact.report.findings,
        setup.evidenceLedger,
        params.headSha,
        {
          checkoutCoverage: params.workspace.reader.getCoverage(),
          isPathInCheckout: (path) => params.workspace.reader.isPathInCheckout(path),
        },
      );
      if (validated.rejected.length > 0) {
        recovery.discardEvidenceCache();
        continue;
      }
      cachedReports.set(
        specialist,
        artifact.report.status === "no_findings"
          ? { kind: "empty", specialist, durationMs: 0, report: artifact.report }
          : {
              kind: "report",
              specialist,
              durationMs: 0,
              report: { ...artifact.report, status: "findings" },
            },
      );
    }
  }
  const recoveredDecisions = (await recovery?.decisions()) ?? [];
  const evidenceMisses = new Set<number>();
  for (const decision of recoveredDecisions) {
    const canonical = decision.prepared.artifact.canonical;
    if (canonical.kind !== "threads") continue;
    if (canonical.openedPaths) {
      for (const path of canonical.openedPaths) setup.evidenceLedger.noteOpened(path);
    }
    const evidenceOk = await revalidateEvidenceDescriptors(
      setup.evidenceLedger,
      canonical.evidence,
      readEvidence,
    );
    if (!evidenceOk) {
      recovery?.discardEvidenceCache();
      evidenceMisses.add(decision.prepared.artifact.sequence);
      continue;
    }
    if (mustRestoreOpens && canonical.openedPaths == null) {
      evidenceMisses.add(decision.prepared.artifact.sequence);
    }
  }
  const briefTool = buildSpecialistBriefTool(phaseRef, {
    initialBrief: cachedBrief,
    onAccepted: recovery
      ? async (brief) => {
          await recovery.save({
            kind: "brief",
            brief,
            openedPaths: [...setup.evidenceLedger.openedPaths()],
          });
        }
      : undefined,
  });
  const state = initialState();
  const coverageNow = (): ReviewCoverage =>
    reviewRunCoverage(state.failedSpecialists, unreadPathsNow(), state.unjudgedSpecialists);
  const restoreCoverageLists = (coverage: ReviewCoverage): void => {
    if (coverage.kind !== "partial") return;
    for (const specialist of coverage.failed ?? []) {
      if (!state.failedSpecialists.includes(specialist)) state.failedSpecialists.push(specialist);
    }
    for (const specialist of coverage.unjudged ?? []) {
      if (!state.unjudgedSpecialists.includes(specialist))
        state.unjudgedSpecialists.push(specialist);
    }
  };
  const agentEvents = resolveAgentEventsContext(params.cfg, params.sessionContext);
  const progressCommentCoordination = params.recordPublishStep?.summaryCommentCoordination;
  const resolveProgressCommentUrl = async (): Promise<string | undefined> => {
    let commentId: number | null | undefined;
    if (progressCommentCoordination) {
      try {
        commentId = await getSummaryCommentGithubId(
          progressCommentCoordination.pool,
          progressCommentCoordination.resourceKey,
          reviewMode,
        );
        if (commentId == null) {
          commentId = params.progressCommentIdHint;
        }
      } catch (error) {
        const appError = toAppError(error, {
          domain: "review",
          kind: "progress_comment_lookup_failed",
        });
        if (recovery) throw appError;
        logWarn("review_progress_comment_lookup_failed", errorLogFields(appError));
        commentId = params.progressCommentIdHint;
      }
    } else {
      commentId = params.progressCommentIdHint;
    }
    if (recovery && commentId == null) {
      commentId = (await params.prSurface.findProgressComment(REVIEW_SUMMARY_SENTINEL))?.id;
    }
    return reviewCheckDetailsUrl(params.owner, params.repo, params.prNumber, commentId);
  };
  const findingInventory = await loadReviewFindingInventory(params);
  const verdictIdentity = ownVerdictPublishParams(params);
  const publishSession = createReviewPublishSession({
    recovery,
    cfg: params.cfg,
    ctx: publishCtx,
    prSurface: setup.prSurface,
    findingInventory,
    mode: reviewMode,
    cachedDiffIndex: setup.cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    progressCommentIdHint: params.progressCommentIdHint,
    recordPublishStep: params.recordPublishStep,
    agentEvents: agentEvents ?? undefined,
    workItemId: params.workItemId,
    operationIntent: params.recordPublishStep?.summaryCommentCoordination
      ? {
          client: params.recordPublishStep.summaryCommentCoordination.pool,
          workItemId: params.recordPublishStep.summaryCommentCoordination.workItemId,
          resourceKey: params.recordPublishStep.summaryCommentCoordination.resourceKey,
          leaseEpoch: params.recordPublishStep.summaryCommentCoordination.leaseEpoch,
        }
      : undefined,
    pool: params.sessionContext?.pool,
    installationId: params.sessionContext?.installationId,
    boss: params.boss,
    verdictWorkItemId: verdictIdentity.workItemId,
    verdictResourceKey: verdictIdentity.resourceKey,
    verdictLeaseEpoch: verdictIdentity.leaseEpoch,
    resolveProgressCommentUrl,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    policyAlert: reviewPolicySummaryAlert(
      params.workspace.policySnapshot,
      params.workspace.reader.changedFiles,
    ),
  });
  const publishThread = buildPublishThreadTool({
    phaseRef,
    session: publishSession,
    policy: {
      repoPolicy: params.repoPolicy,
      policyBaseSha: recordedPolicyBaseSha(params.workspace.policySnapshot),
      boundPolicyJudge: createBoundPolicyJudge(params.cfg),
      readCheckoutFile: async (relativePath) => {
        try {
          const safePath = assertWorkspacePath(params.workspace.agentCwd, relativePath);
          return await readFile(safePath, "utf8");
        } catch {
          return undefined;
        }
      },
      evidenceLedger: setup.evidenceLedger,
      checkoutCoverage: params.workspace.reader.getCoverage(),
      isPathInCheckout: (path) => params.workspace.reader.isPathInCheckout(path),
    },
    inventory: findingInventory,
    initialLedger:
      recoveredDecisions[0]?.prepared.artifact.canonical.kind === "threads"
        ? createFindingLedger(recoveredDecisions[0].prepared.artifact.canonical.ledgerBefore)
        : initialLedger(params),
  });
  setup.bindReviewThreads?.(() =>
    openReviewThreads(findingInventory, acceptedOpenThreads(publishThread.getLedger())),
  );
  const recoveredSources = new Set<SpecialistId>();
  let recoveredSummary = false;
  let recoveredCheck: FindingCheck | null = null;
  for (const decision of recoveredDecisions) {
    const canonical = decision.prepared.artifact.canonical;
    if (canonical.kind === "threads") {
      if ((await params.gate.check()).kind !== "continue") break;
      const withoutEvidence = evidenceMisses.has(decision.prepared.artifact.sequence);
      await publishThread.replay(decision, withoutEvidence);
      if (publishThread.getStopReason()) break;
      if (canonical.source !== "review" && !withoutEvidence) recoveredSources.add(canonical.source);
    } else {
      if (evidenceMisses.size > 0) continue;
      const result = await publishReviewSummaryOnly(publishSession, {
        payload: decision.prepared.artifact.payload,
        ledger: createFindingLedger(canonical.ledger),
        coverage: canonical.coverage,
        staleReview: canonical.staleReview,
        recoveryDecision: decision,
      });
      recoveredSummary = result.kind === "published";
      recoveredCheck = result.kind === "published" ? result.check : null;
      restoreCoverageLists(canonical.coverage);
    }
  }
  const savedFinalSummary =
    recoveredSummary || evidenceMisses.size > 0 ? null : await recovery?.load("final-summary");
  if (
    savedFinalSummary?.artifact.kind === "final_summary" &&
    savedFinalSummary.artifact.inputs?.kind === "summary"
  ) {
    const inputs = savedFinalSummary.artifact.inputs;
    const result = await publishReviewSummaryOnly(publishSession, {
      payload: savedFinalSummary.artifact.payload,
      ledger: createFindingLedger(inputs.ledger),
      coverage: inputs.coverage,
      staleReview: inputs.staleReview,
    });
    recoveredSummary = result.kind === "published";
    recoveredCheck = result.kind === "published" ? result.check : null;
    restoreCoverageLists(inputs.coverage);
  }
  if (recovery?.getJudgmentDegraded()) state.judgment = "degraded";
  state.briefFallback = recovery?.getBriefFallback() ?? false;
  const summaryState = createPublishSummaryState({
    published: recoveredSummary || params.initialPublishState?.published,
    check: recoveredCheck,
  });
  const publishSummary = buildPublishSummaryTool({
    phaseRef,
    session: publishSession,
    state: summaryState,
    getLedger: publishThread.getLedger,
    getCoverage: () => coverageNow(),
  });
  const declareDuplicate = buildDeclareDuplicateTool({ phaseRef, session: publishSession });
  const allTools = [
    ...setup.workspaceTools.piTools,
    briefTool.piTool,
    publishThread.piTool,
    declareDuplicate.piTool,
    publishSummary.piTool,
  ];
  const allExecutors = {
    ...setup.workspaceTools.executors,
    submit_specialist_brief: briefTool.executor,
    publish_thread: publishThread.executor,
    declare_duplicate: declareDuplicate.executor,
    publish_summary: publishSummary.executor,
  };
  let session: PiSession | null = null;
  let sessionCreation: Promise<PiSession> | null = null;
  let recoveryBootstrapPending = cachedBrief !== undefined || recoveredDecisions.length > 0;
  try {
    sessionCreation = recoveredSummary
      ? null
      : params.createSession({
          role: "orchestrator",
          cfg: params.cfg,
          cwd: sessionCwd,
          systemPrompt: orchestratorSystemPrompt,
          tools: allTools,
          executors: allExecutors,
          attemptModel: params.escalation?.model,
          sessionContext: params.sessionContext,
          hostSignal: params.signal,
        });
    const creation = sessionCreation
      ? await settleBefore(
          sessionCreation,
          Math.min(params.timing.modelStopAtMs, params.timing.returnByMs),
          params.signal,
        )
      : { kind: "aborted" as const };
    if (creation.kind === "settled") {
      session = creation.value;
    } else if (creation.kind === "deadline") {
      state.judgment = "degraded";
      state.lifecycle = { kind: "finalizing", reason: "deadline" };
      void sessionCreation
        ?.then(async (lateSession) => {
          await lateSession.abort().catch(() => undefined);
          await lateSession.dispose().catch(() => undefined);
        })
        .catch(() => undefined);
      const deadlineFailure = classifyFailure(
        new AppError({
          domain: "review",
          kind: "orchestrator_session_create_deadline",
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
    } else if (creation.kind === "aborted") {
      void sessionCreation
        ?.then(async (lateSession) => {
          await lateSession.abort().catch(() => undefined);
          await lateSession.dispose().catch(() => undefined);
        })
        .catch(() => undefined);
    } else if (creation.kind === "rejected") {
      state.judgment = "degraded";
      const appError = toAppError(creation.error, {
        domain: "review",
        kind: "orchestrator_session_create_failed",
        context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
      });
      const failure = classifyFailure(appError, { phase: "recon" });
      recordClassifiedFailure(failure);
      logWarn("review_orchestrator_session_create_failed", {
        ...errorLogFields(appError),
        ...classifiedFailureLogFields(failure),
      });
    } else {
      const exhaustive: never = creation;
      return exhaustive;
    }
  } catch (error) {
    state.judgment = "degraded";
    const appError = toAppError(error, {
      domain: "review",
      kind: "orchestrator_session_create_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
    const failure = classifyFailure(appError, { phase: "recon" });
    recordClassifiedFailure(failure);
    logWarn("review_orchestrator_session_create_failed", {
      ...errorLogFields(appError),
      ...classifiedFailureLogFields(failure),
    });
  }
  const specialistControllers = new Map<SpecialistId, AbortController>();
  let sessionRetired = session == null;
  let lastText = "";
  let publishAttempts = 0;
  let publishStepCount = 0;
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

  const stopFromGateResult = async (gate: ReviewRunGateResult): Promise<boolean> => {
    if (gate.kind === "continue") return false;
    state.lifecycle =
      gate.kind === "stop"
        ? gate.reason === "cancelled"
          ? {
              kind: "stopped",
              reason: "cancelled",
              attribution: gate.attribution,
            }
          : { kind: "stopped", reason: gate.reason }
        : { kind: "finalizing", reason: gate.reason };
    abortSpecialists();
    await retireSession();
    return true;
  };

  const sendWithRetry = async (
    phase: "recon" | "judgment" | "synthesis",
    prompt: string,
    options?: Pick<PiSessionSendOptions, "maxToolRounds" | "deadlineMs" | "reservedTerminalTool">,
  ): Promise<SendResult> => {
    phaseRef.current = phase;
    const turnPrompt = recoveryBootstrapPending
      ? renderOrchestratorRecoveryBootstrap({
          userContent: setup.orchestratorUserContent,
          briefSerialized: JSON.stringify(cachedBrief ?? {}),
          reportsSerialized: [...cachedReports]
            .filter(
              ([specialist]) =>
                !recoveredSources.has(specialist) && state.specialists[specialist].phase !== "done",
            )
            .flatMap(([specialist, outcome]) =>
              outcome.kind === "report" || (outcome.kind === "empty" && outcome.report)
                ? [{ specialist, reportSerialized: JSON.stringify(outcome.report) }]
                : [],
            ),
          ledgerSerialized: JSON.stringify(publishThread.getLedger().accepted),
          prompt,
        })
      : prompt;
    if (recoveryBootstrapPending) {
      recoveryBootstrapPending = false;
    }
    let firstError: AppError | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (sessionRetired || !session) {
        return {
          kind: "failed",
          error:
            firstError ??
            new AppError({
              domain: "review",
              kind: "orchestrator_session_retired",
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
            domain: "review",
            kind: "orchestrator_model_deadline",
            message: "Orchestrator model deadline reached",
            context: { phase, attempt },
          }),
        };
      }
      if (gate.kind === "stop") {
        await stopFromGateResult(gate);
        return {
          kind: "failed",
          error: new AppError({
            domain: "review",
            kind: "orchestrator_stopped",
            message: "Orchestrator stopped before the model send",
            context: { phase, attempt, reason: gate.reason },
          }),
        };
      }
      try {
        const sendPromise = session.send(turnPrompt, {
          ...options,
          phase,
          checkpointId: `${session.role}:${phase}`,
        });
        const send = await settleBefore(
          sendPromise,
          Math.min(params.timing.modelStopAtMs, params.timing.returnByMs),
          params.signal,
        );
        if (send.kind === "deadline") {
          state.lifecycle = { kind: "finalizing", reason: "deadline" };
          abortSpecialists();
          await retireSession();
          void sendPromise.catch(() => undefined);
          return {
            kind: "failed",
            error: new AppError({
              domain: "review",
              kind: "orchestrator_model_deadline",
              message: "Orchestrator model deadline reached during send",
              context: { phase, attempt },
            }),
          };
        }
        if (send.kind === "aborted") {
          void sendPromise.catch(() => undefined);
          await session.abort().catch(() => undefined);
          await stopFromGateResult(await params.gate.check());
          return {
            kind: "failed",
            error: new AppError({
              domain: "agent",
              kind: "session_aborted",
              message: "Orchestrator send aborted by host signal",
              context: { phase, attempt },
            }),
          };
        }
        if (send.kind === "rejected") throw send.error;
        if (send.kind !== "settled") {
          const exhaustive: never = send;
          return exhaustive;
        }
        recordAgentTurnMetrics(send.value);
        return { kind: "sent", text: send.value.text, end: send.value.end };
      } catch (error) {
        recovery?.throwIfFailed();
        const appError = toAppError(error, {
          domain: "review",
          kind: "orchestrator_send_failed",
          context: { phase, attempt },
        });
        firstError ??= appError;
        if (isCancelAbortError(error) || params.signal?.aborted) {
          await stopFromGateResult(await params.gate.check());
          return { kind: "failed", error: appError };
        }
        if (isProviderRefusalError(appError)) {
          await retireSession();
          break;
        }
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
        domain: "review",
        kind: "orchestrator_send_failed",
        message: "Orchestrator send failed twice",
        context: { phase },
      });

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
      installationId: params.sessionContext?.installationId,
      boss: params.boss,
    });
  };

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
      installationId: params.sessionContext?.installationId,
      boss: params.boss,
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
    recovery?.setCoverage(coverageNow());
  };

  const recordUnjudgedReport = async (
    outcome: Extract<SpecialistOutcome, { readonly kind: "report" }>,
    cause: JudgmentDegradeCause,
  ): Promise<void> => {
    if (state.lifecycle.kind === "stopped") return;
    const publishStop = await publishSession.stopReason();
    if (publishStop != null) {
      state.lifecycle = { kind: "stopped", reason: publishStop };
      abortSpecialists();
      await retireSession();
      return;
    }
    state.judgment = "degraded";
    recovery?.setJudgmentDegraded(true);
    if (!state.unjudgedSpecialists.includes(outcome.specialist)) {
      state.unjudgedSpecialists.push(outcome.specialist);
    }
    setReviewRunMetricFields({ judgmentDegraded: true });
    recovery?.setCoverage(coverageNow());
    if (agentEvents) {
      const submittedCount = outcome.report.findings.length;
      const alreadyAccepted = countAcceptedForSource(publishThread.getLedger(), outcome.specialist);
      safeEmitDecisionEvent(agentEvents, params.cfg, {
        specialist: outcome.specialist,
        phase: "judgment",
        submittedCount,
        acceptedCount: 0,
        rejectedCount: 0,
        unjudgedCount: Math.max(0, submittedCount - alreadyAccepted),
        degradedReason: cause.reason,
        severityRaised: 0,
        severityLowered: 0,
        ...(cause.reason === "judgment_unpublished" ? { turnEnd: cause.turnEnd } : {}),
      });
    }
    if (cause.reason === "judgment_failed") {
      const appError = toAppError(cause.error, {
        domain: "review",
        kind: "orchestrator_report_handler_failed",
        context: { specialist: outcome.specialist },
      });
      logWarn("review_orchestrator_report_handler_failed", {
        specialist: outcome.specialist,
        ...errorLogFields(appError),
      });
    }
    if (cause.reason === "judgment_unavailable") await retireSession();
    state.specialists[outcome.specialist] = {
      phase: "done",
      findingsAccepted: countAcceptedForSource(publishThread.getLedger(), outcome.specialist),
    };
    await writeTick();
  };

  const publishDeterministicSummary = async (): Promise<void> => {
    if (summaryState.published) return;
    const ledger = publishThread.getLedger();
    const payload = reviewPayloadFromFindings(ledgerFindings(ledger));

    let result: Awaited<ReturnType<typeof publishReviewSummaryOnly>>;
    try {
      result = await publishReviewSummaryOnly(publishSession, {
        payload,
        ledger,
        coverage: coverageNow(),
      });
    } catch (error) {
      publishAttempts += 1;
      throw error;
    }
    if (result.kind === "stopped") {
      state.lifecycle = { kind: "stopped", reason: result.reason };
      return;
    }
    summaryState.published = true;
    summaryState.check = result.check;
    state.summary = { kind: "published" };
  };

  const publishFailureNotice = async (): Promise<void> => {
    const lastFailure = snapshotReviewRunMetrics()?.lastFailure ?? undefined;
    await publishReviewRunFailureNotice({
      cfg: params.cfg,
      setup,
      summaryCoordination: params.recordPublishStep?.summaryCommentCoordination,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      reviewMode,
      publishAttempts,
      ...(lastFailure != null ? { lastFailure } : {}),
      findingView: buildFindingView(
        findingInventory,
        { kind: "not_reviewed" },
        params.cfg.review.checkFailSeverity,
      ),
    });
    state.summary = { kind: "failed" };
  };

  let outcomes: SpecialistOutcome[] = [];
  let recoveryRoundsRun = 0;

  const stepFacts = (): ReviewStepFacts => ({
    hasSession: session != null,
    sessionRetired,
    briefSubmitted: briefTool.getBrief() != null,
    hostAborted: params.signal?.aborted === true,
    lifecycle: state.lifecycle.kind,
    failedSpecialists: state.failedSpecialists.length,
    specialistCount: SPECIALIST_IDS.length,
    summaryPublished: summaryState.published,
    recoveryRoundsRun,
    recoveryRoundLimit: PUBLISH_RECOVERY_ROUNDS,
  });

  const runStep = async (step: ReviewStep): Promise<void> => {
    switch (step.kind) {
      case "recon": {
        if (cachedBrief || recoveredSummary) break;
        const recon = await sendWithRetry(
          "recon",
          renderOrchestratorReconTurn(setup.orchestratorUserContent),
          { maxToolRounds: escalatedToolRounds(MAX_TOOL_ROUNDS, params.escalation) },
        );
        if (recon.kind === "sent") lastText = recon.text;
        else state.judgment = "degraded";
        break;
      }
      case "repair_brief": {
        await runValidationRepairLoop({
          rounds: VALIDATION_REPAIR_ROUNDS,
          shouldContinue: () => briefTool.getBrief() == null && !sessionRetired,
          getValidationError: () =>
            briefTool.getValidationError() ?? ORCHESTRATOR_MISSING_BRIEF_ERROR,
          clearValidationError: briefTool.clearValidationError,
          repair: async (validationError) => {
            const repair = await sendWithRetry(
              "recon",
              renderOrchestratorBriefRepair(validationError),
              { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
            );
            if (repair.kind === "sent") lastText = repair.text;
            else state.judgment = "degraded";
          },
        });
        break;
      }
      case "stop_on_host_abort": {
        await stopFromGateResult(await params.gate.check());
        break;
      }
      case "dispatch_specialists": {
        if (recoveredSummary) {
          state.lifecycle = { kind: "complete" };
          break;
        }
        const submittedBrief = briefTool.getBrief();
        const brief = submittedBrief ?? fallbackBrief(params);
        if (submittedBrief == null) {
          state.briefFallback = true;
          recovery?.setBriefFallback(true);
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
          const cached = cachedReports.get(specialist);
          if (cached) {
            pending.set(specialist, Promise.resolve(cached));
            continue;
          }
          const controller = new AbortController();
          specialistControllers.set(specialist, controller);
          pending.set(
            specialist,
            runSpecialist({
              cfg: params.cfg,
              cwd: sessionCwd,
              specialist,
              briefMessage: appendTrustedSpecialistContext(
                renderBriefMessage(
                  brief,
                  specialist,
                  submittedBrief == null
                    ? {
                        pullRequestMetadata: { title: params.prTitle, body: params.prBody },
                      }
                    : undefined,
                ),
                setup.trustedContext,
              ),
              workspaceTools: setup.workspaceTools,
              timeoutMs: Math.max(
                0,
                Math.min(params.cfg.review.specialistTimeoutMs, params.timing.remainingModelMs()),
              ),
              shouldContinue: () => state.lifecycle.kind === "running",
              signal: combineAbortSignals([params.signal, controller.signal]),
              evidenceLedger: setup.evidenceLedger,
              headSha: params.headSha,
              checkoutCoverage: params.workspace.reader.getCoverage(),
              isPathInCheckout: (path) => params.workspace.reader.isPathInCheckout(path),
              agentEvents: agentEvents ?? undefined,
              escalation: params.escalation,
              createSession: params.createSession,
              onValidatedReport: recovery
                ? async (report) => {
                    const evidence = evidenceForCachedFindings(
                      setup.evidenceLedger,
                      report.findings,
                    );
                    if (evidence === null) {
                      recovery.discardEvidenceCache();
                      return;
                    }
                    await recovery.save({
                      kind: "report",
                      specialist,
                      report,
                      evidence,
                      openedPaths: [...setup.evidenceLedger.openedPaths()],
                    });
                  }
                : undefined,
            }),
          );
        }

        outcomes = await pumpSpecialistCompletions({
          pending,
          shouldContinue: () => state.lifecycle.kind === "running",
          onOutcome: async (outcome) => {
            try {
              if (await stopFromGateResult(await params.gate.check())) return;

              await recordOutcome(outcome);
              if (outcome.kind !== "report") return;
              if (recoveredSources.has(outcome.specialist)) {
                state.specialists[outcome.specialist] = {
                  phase: "done",
                  findingsAccepted: publishThread
                    .getLedger()
                    .accepted.filter((entry) => entry.source === outcome.specialist).length,
                };
                await writeTick();
                return;
              }
              const judgmentSession = session;
              if (sessionRetired || !judgmentSession) {
                await recordUnjudgedReport(outcome, { reason: "judgment_unavailable" });
                return;
              }

              publishThread.setSource(outcome.specialist);
              publishThread.setReport(outcome.report);
              const ledgerBefore = publishThread.getLedger();
              publishStepCount += 1;
              const judgment = await sendWithRetry(
                "judgment",
                renderJudgmentTurn(
                  outcome,
                  slimAcceptedFindings(outcome, ledgerBefore),
                  judgmentInventory(
                    findingInventory,
                    outcome.report.findings,
                    ledgerBefore.accepted,
                  ),
                ),
                {
                  maxToolRounds: escalatedToolRounds(
                    ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS,
                    params.escalation,
                  ),
                  reservedTerminalTool: "publish_thread",
                },
              );
              if (judgment.kind === "failed") {
                await recordUnjudgedReport(outcome, {
                  reason: "judgment_failed",
                  error: judgment.error,
                });
                return;
              }
              lastText = judgment.text;
              if (await applyPublishStop()) return;
              if (
                outcome.report.findings.length > 0 &&
                publishThread.getLedger().threadCallCount === ledgerBefore.threadCallCount
              ) {
                logWarn("review_judgment_unpublished", {
                  owner: params.owner,
                  repo: params.repo,
                  pr: params.prNumber,
                  specialist: outcome.specialist,
                  findings: outcome.report.findings.length,
                  turnEnd: judgment.end,
                });
                await recordUnjudgedReport(outcome, {
                  reason: "judgment_unpublished",
                  turnEnd: judgment.end,
                });
                return;
              }
              state.specialists[outcome.specialist] = specialistDonePhase(
                ledgerBefore,
                publishThread.getLedger(),
                outcome.specialist,
              );
              await writeTick();
            } catch (error) {
              recovery?.throwIfFailed();
              await recordOutcome(outcome);
              if (outcome.kind === "report") {
                await recordUnjudgedReport(outcome, { reason: "judgment_failed", error });
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
            if (outcome.kind === "report") {
              if (sessionRetired || !session) {
                await recordUnjudgedReport(outcome, { reason: "judgment_unavailable" });
              } else {
                await recordUnjudgedReport(outcome, {
                  reason: "judgment_failed",
                  error: new AppError({
                    domain: "review",
                    kind: "orchestrator_outcome_unhandled",
                    message: "Specialist outcome missed judgment pump",
                    context: { specialist: outcome.specialist },
                  }),
                });
              }
            }
          }
        }

        break;
      }
      case "terminal_tick": {
        if (state.lifecycle.kind === "stopped") await writeTerminalTick(state.lifecycle);
        break;
      }
      case "finalize_deadline": {
        for (const outcome of outcomes) {
          if (state.outcomes[outcome.specialist] == null) await recordOutcome(outcome);
          if (
            outcome.kind === "report" &&
            state.specialists[outcome.specialist].phase === "running"
          ) {
            await recordUnjudgedReport(outcome, { reason: "judgment_unavailable" });
          }
        }
        state.judgment = "degraded";
        if (state.failedSpecialists.length === SPECIALIST_IDS.length) {
          await publishFailureNotice();
        } else {
          await publishDeterministicSummary();
        }
        markCompleteUnlessStopped();
        break;
      }
      case "failure_notice": {
        await publishFailureNotice();
        state.lifecycle = { kind: "complete" };
        break;
      }
      case "synthesis": {
        if (recoveredSummary) break;
        publishStepCount += 1;
        const synthesisPrompt = renderSynthesisTurn({
          acceptedFindings: publishThread.getLedger().accepted,
          partialSpecialists: state.failedSpecialists,
          outcomes: state.completionOrder.flatMap((specialist) => {
            const outcome = state.outcomes[specialist];
            return outcome ? [outcome] : [];
          }),
        });
        const synthesis = await sendWithRetry("synthesis", synthesisPrompt, {
          maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS,
        });
        if (synthesis.kind === "sent") lastText = synthesis.text;
        else state.judgment = "degraded";
        await applyPublishStop();
        break;
      }
      case "repair_summary": {
        await runValidationRepairLoop({
          rounds: VALIDATION_REPAIR_ROUNDS,
          shouldContinue: () =>
            !summaryState.published && !sessionRetired && state.lifecycle.kind === "running",
          getValidationError: () =>
            summaryState.lastValidationError ?? ORCHESTRATOR_MISSING_SUMMARY_ERROR,
          clearValidationError: () => {
            summaryState.lastValidationError = null;
          },
          repair: async (validationError) => {
            const repair = await sendWithRetry(
              "synthesis",
              renderOrchestratorSummaryRepair(validationError),
              { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
            );
            if (repair.kind === "sent") lastText = repair.text;
            else state.judgment = "degraded";
            await applyPublishStop();
          },
        });

        break;
      }
      case "recover_summary": {
        recoveryRoundsRun += 1;
        const summaryRecovery = await sendWithRetry(
          "synthesis",
          ORCHESTRATOR_RECOVER_SUMMARY_INSTRUCTION,
          { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS },
        );
        if (summaryRecovery.kind === "sent") lastText = summaryRecovery.text;
        else state.judgment = "degraded";
        await applyPublishStop();
        break;
      }
      case "settle_summary": {
        if (publishThread.getStopReason() != null || summaryState.stoppedReason != null) {
          state.summary = { kind: "pending" };
        } else if (summaryState.published) {
          state.summary = { kind: "published" };
        } else {
          if (!sessionRetired) {
            const lastFailure = snapshotReviewRunMetrics()?.lastFailure;
            logWarn("review_synthesis_publish_salvage", {
              owner: params.owner,
              repo: params.repo,
              pr: params.prNumber,
              publishAttempts,
              judgment: state.judgment,
              lastValidationError: summaryState.lastValidationError,
              ...(lastFailure != null ? classifiedFailureLogFields(lastFailure) : {}),
            });
          }
          await publishDeterministicSummary();
        }
        markCompleteUnlessStopped();
        break;
      }
      case "deterministic_summary": {
        await publishDeterministicSummary();
        markCompleteUnlessStopped();
        break;
      }
      case "done":
        break;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  };

  try {
    await writeWorkerStartTick();
    let step = nextStep(null, stepFacts());
    while (step.kind !== "done") {
      await runStep(step);
      recovery?.throwIfFailed();
      step = nextStep(step.kind, stepFacts());
    }
  } catch (error) {
    abortSpecialists();
    await retireSession();
    throw toAppError(error, {
      domain: "review",
      kind: "orchestrator_run_failed",
      context: { owner: params.owner, repo: params.repo, pr: params.prNumber },
    });
  } finally {
    if (session) {
      const disposePromise = session.dispose();
      await settleBefore(disposePromise, params.timing.returnByMs);
      void disposePromise.catch(() => undefined);
    }
    const leftoverSpillPaths = await setup.disposeSpillFiles().catch(() => undefined);
    if (leftoverSpillPaths != null && leftoverSpillPaths.length > 0) {
      logWarn("review_spill_files_undisposed", {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        spillPaths: leftoverSpillPaths,
      });
    }
  }

  const specialistOutcomes: Record<string, number> = {};
  for (const outcome of Object.values(state.outcomes)) {
    if (!outcome) continue;
    specialistOutcomes[outcome.kind] = (specialistOutcomes[outcome.kind] ?? 0) + 1;
  }
  const ledger = publishThread.getLedger();
  const postedSeverities = ledger.accepted.flatMap((placement) =>
    placement.kind === "summary_only" ? [] : [placement.placement.finding.severity],
  );
  setReviewRunMetricFields({
    published: summaryState.published,
    publishAttempts,
    publishStepCount,
    specialistOutcomes,
    threadBatches: publishThread.getPublishedBatchCount(),
    briefFallback: state.briefFallback,
    findingsCount: ledger.postedInlineCount,
    submitCallCount: ledger.threadCallCount,
    severities: postedSeverities,
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
    params.cfg.models.provider,
  );
  const lastFailure = snapshotReviewRunMetrics()?.lastFailure ?? undefined;
  const runCoverage = coverageNow();
  return {
    lastAssistant,
    published: summaryState.published,
    publishAttempts,
    publishStepCount,
    publishSuperseded: state.lifecycle.kind === "stopped",
    ...(lastFailure != null ? { lastFailure } : {}),
    ...(summaryState.published
      ? {
          ...(summaryState.check != null ? { findingCheck: summaryState.check } : {}),
          coverage: runCoverage,
        }
      : {}),
  };
}
