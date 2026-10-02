import type { BotIdentity } from "../github/appAuth.js";
import { createPublishContext } from "../agentWork/publishOnce.js";
import { join } from "node:path";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import {
  degradedReasonFromReviewFlags,
  durationMsFromClaim,
  reviewWorkOutcome,
  workFailureReasonFromClassified,
  type WorkCompletedOutcome,
} from "../analytics/workCompleted.js";
import { AppError } from "../errors/appError.js";
import { classifyFailure, classifiedFailureLogFields } from "../errors/classifiedFailure.js";
import type { PrSurface } from "../github/prSurface.js";
import { runWithRateLimitCircuit } from "../github/rateLimitCircuit.js";
import { openRunRateLimitCircuit } from "../agent/runtime/rateLimitCircuit.js";
import {
  assertPullRequestFilesHeadSha,
  type ListPullRequestFilesResult,
  type PullRequestForFileList,
} from "../github/listPullRequestFiles.js";
import { runOrchestratedPrReview } from "./orchestrator/orchestratorRun.js";
import type { ReviewRunResult } from "./run/reviewRunTypes.js";
import type { ReviewRunGate, ReviewRunTiming } from "./orchestrator/orchestratorTypes.js";
import { loadRepoPolicy, renderRepoPolicyBlock } from "./repoPolicy.js";
import {
  isSameRepoPullRequest,
  loadAgentInstructionFiles,
  renderAgentInstructionFilesBlock,
} from "./agentInstructionFiles.js";
import {
  buildTrustedReviewContextForReview,
  fetchPriorInlineFeedbackBlockForReview,
} from "./prompts/reviewTrustedContext.js";
import {
  resolveAgentEventsContext,
  safeEmitCoverageEvent,
} from "../agent/runtime/agentEventSink.js";
import { buildReviewPreflightMetadataFromPullRequestFiles } from "./placement/reviewPreflightFiles.js";
import type { ReviewMode } from "./reviewSchema.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewMetric,
  recordReviewPhaseSpan,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "./run/reviewRunMetrics.js";
import { logInfo, logWarn } from "../evlog.js";
import { attachSummaryCommentCoordination } from "./publish/reviewSummaryComment.js";
import type { createFeaturePiSession } from "../agent/runtime/createFeatureSession.js";
import type { PrRepositoryView } from "../prWorkspace/prRepositoryView.js";
import { prBodyHasDescriptionReviewMap } from "../agent/description/descriptionRender.js";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_AGENT_INSTRUCTION_BYTES,
  REPO_POLICY_DIRNAME,
  MAX_PR_FILES_LISTED,
  MAX_PR_FILES_PATCH_BYTES,
  REVIEW_FINALIZATION_WINDOW_MS,
} from "../settings/index.js";
import { tryLightweightAutoReviewCompletion } from "../agentWork/reviewLightweightCompletion.js";
import {
  reviewVerdict,
  type OwnVerdictOutcome,
  ownVerdictFromSummaryDetail,
} from "../agentWork/reviewVerdict.js";
import {
  formatFindingHistoryTrustedBlock,
  safeLoadCrossPrSuppressionFingerprints,
  safeLoadFindingHistoryCandidates,
} from "../agentWork/findingHistoryRepository.js";
import {
  loadReviewExecutorPublishContext,
  type ReviewExecutorPublishContext,
} from "../agentWork/publishRecordRepository.js";
import { getWorkItem, shouldSkipWork } from "../agentWork/workItemStateRepository.js";

import {
  staleHeadReplacementExhaustedError,
  tryBuildStaleReviewRescheduleResult,
  type StaleReviewRescheduleResult,
} from "../agentWork/reviewReschedule.js";
import type { EscalationPlan } from "../agentWork/retryPolicy.js";
import {
  type DurableExecutionContext,
  type DurableExecutionResult,
} from "../agentWork/durableJob.js";
import { type ReviewWorkItem, type ReviewWorkPayload } from "../agentWork/types.js";
import { createAskPathGate } from "../agent/ask/askSafety.js";
import { prepareCodeIndexForReview } from "../codeIndex/buildJob.js";
import type { ReviewProfileFields, WorkCompletion } from "../analytics/workCompleted.js";
import type { ReviewRunMetricsSnapshot } from "./run/reviewRunMetrics.js";

type ReviewDegradationReason = "publish_not_completed";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type SettledPriorInlineFeedback = Result<string | undefined>;

type LightweightPhaseResult =
  | { readonly done: true; readonly result: DurableExecutionResult }
  | { readonly done: false; readonly prefetchedPrFiles: ListPullRequestFilesResult | undefined };

function reviewRunTimingFromJob(job: JobWithMetadata<{ workItemId: string }>): ReviewRunTiming {
  const startedOnMs = job.startedOn.getTime();
  const returnByMs = startedOnMs + job.expireInSeconds * 1000 * 0.8;
  const modelStopAtMs = Math.max(startedOnMs, returnByMs - REVIEW_FINALIZATION_WINDOW_MS);
  return {
    returnByMs,
    modelStopAtMs,
    remainingModelMs: (now = Date.now()) => Math.max(0, modelStopAtMs - now),
    remainingTotalMs: (now = Date.now()) => Math.max(0, returnByMs - now),
  };
}

function reviewRunGate(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly headSha: string;
  readonly timing: ReviewRunTiming;
  readonly prSurface: PrSurface;
  readonly publishAbortState: { staleHead?: boolean };
  readonly staleHeadAtPublish: { value: boolean };
}): ReviewRunGate {
  const deadlineReached = () =>
    Date.now() >= args.timing.modelStopAtMs || Date.now() >= args.timing.returnByMs;
  return {
    check: async () => {
      if (deadlineReached()) return { kind: "finalize", reason: "deadline" };
      if (await shouldSkipWork(args.pool, args.item)) {
        const fresh = await getWorkItem(args.pool, args.item.id);
        const attribution = fresh?.type === "review" ? fresh.payload.cancelAttribution : undefined;
        if (attribution != null) {
          return { kind: "stop", reason: "cancelled", attribution };
        }
        return { kind: "stop", reason: "superseded" };
      }
      if (deadlineReached()) return { kind: "finalize", reason: "deadline" };
      const latestHeadSha = await args.prSurface.getHeadSha();
      if (latestHeadSha !== args.headSha) {
        args.staleHeadAtPublish.value = true;
        args.publishAbortState.staleHead = true;
        return { kind: "stop", reason: "stale_head" };
      }
      if (deadlineReached()) return { kind: "finalize", reason: "deadline" };
      return { kind: "continue" };
    },
  };
}

/**
 * Build a deferred-head replacement when the parent can still own reschedule.
 * Runs optional pre-work (check-run cancel) only after the skip guard passes.
 */
async function scheduleStaleHeadReplacement(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly leaseEpoch: number | null;
  readonly beforeBuild?: () => Promise<void>;
}): Promise<StaleReviewRescheduleResult | undefined> {
  if (args.leaseEpoch == null) {
    throw new AppError({
      code: "agent_work.pr_actor_lease_lost",
      message: "PR actor lease is no longer held by this execution",
      context: { workItemId: args.item.id },
    });
  }
  if (await shouldSkipWork(args.pool, args.item)) {
    return undefined;
  }
  await args.beforeBuild?.();
  return (
    (await tryBuildStaleReviewRescheduleResult(args.pool, args.item, args.leaseEpoch)) ?? undefined
  );
}

/** Resume a parent that already persisted a replacement marker but has not finished enqueue. */
async function handleStaleHeadReschedule(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly prSurface: PrSurface;
  readonly leaseEpoch: number | null;
  readonly commitStatusEnabled: boolean;
}): Promise<StaleReviewRescheduleResult | undefined> {
  const { pool, item, reviewLens, payload, prSurface, leaseEpoch, commitStatusEnabled } = args;
  if (
    (payload.source !== "slash" && payload.source !== "auto") ||
    payload.staleHeadRescheduled ||
    payload.staleHeadReplacement === undefined
  ) {
    return undefined;
  }
  return scheduleStaleHeadReplacement({
    pool,
    item,
    leaseEpoch,
    beforeBuild: async () => {
      await reviewVerdict({
        pool,
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        headSha: item.headSha,
        leaseEpoch,
        commitStatusEnabled,
        summaryCommentId: null,
      }).close({ kind: "stale_head" });
    },
  });
}

async function closeStoredReviewVerdict(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly prSurface: PrSurface;
  readonly leaseEpoch: number | null;
  readonly commitStatusEnabled: boolean;
  readonly outcome: OwnVerdictOutcome;
  readonly lastFailure?: ReviewRunResult["lastFailure"];
}): Promise<void> {
  const {
    pool,
    item,
    reviewLens,
    prSurface,
    leaseEpoch,
    commitStatusEnabled,
    outcome,
    lastFailure,
  } = args;
  if (outcome.kind === "not_published" && lastFailure != null) {
    logWarn("review_check_run_failure_classified", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      ...classifiedFailureLogFields(lastFailure),
    });
  }
  await reviewVerdict({
    pool,
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    headSha: item.headSha,
    leaseEpoch,
    commitStatusEnabled,
  }).close(outcome);
}

async function runLightweightCompletionOrSkip(args: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly leaseEpoch: number | null;
  readonly commitStatusEnabled: boolean;
  readonly profile: ReviewProfileSession;
  readonly beginAttempt: DurableExecutionContext["beginAttempt"];
}): Promise<LightweightPhaseResult> {
  const {
    cfg,
    pool,
    boss,
    item,
    reviewLens,
    payload,
    prSurface,
    headSha,
    leaseEpoch,
    commitStatusEnabled,
  } = args;
  if (payload.source !== "auto") {
    return { done: false, prefetchedPrFiles: undefined };
  }
  const prefetchedPrFiles = await recordReviewPhaseSpan("preflight", () =>
    prSurface.listChangedFiles(
      {
        maxPrFilesListed: MAX_PR_FILES_LISTED,
        maxPrFilesPatchBytes: MAX_PR_FILES_PATCH_BYTES,
      },
      undefined,
    ),
  );
  const observedHeadSha = prefetchedPrFiles.headSha;
  if (
    observedHeadSha != null &&
    observedHeadSha.length > 0 &&
    observedHeadSha.toLowerCase() !== headSha.toLowerCase()
  ) {
    if (payload.staleHeadRescheduled) {
      throw staleHeadReplacementExhaustedError(item);
    }
    const reschedule = await scheduleStaleHeadReplacement({
      pool,
      item,
      leaseEpoch,
      beforeBuild: () =>
        closeStoredReviewVerdict({
          pool,
          item,
          reviewLens,
          prSurface,
          leaseEpoch,
          commitStatusEnabled,
          outcome: { kind: "stale_head" },
        }),
    });
    if (reschedule) {
      return { done: true, result: reschedule };
    }
  }
  assertPullRequestFilesHeadSha(prefetchedPrFiles, headSha);
  const preflight = buildReviewPreflightMetadataFromPullRequestFiles(prefetchedPrFiles);
  await args.beginAttempt();
  const lightweightResult = await tryLightweightAutoReviewCompletion(pool, {
    item,
    reviewLens,
    prSurface,
    preflight,
    model: cfg.piModel,
    leaseEpoch,
    boss,
  });
  if (!lightweightResult.handled) {
    return { done: false, prefetchedPrFiles };
  }
  logInfo("review_lightweight_completion", {
    owner: item.owner,
    repo: item.repo,
    pr: item.prNumber,
    reviewLens,
    published: lightweightResult.published,
  });
  setReviewRunMetricFields({
    published: lightweightResult.published,
    publishAttempts: 0,
    lightweight: true,
  });
  logReviewRunCompleted();
  args.profile.record({ outcome: "lightweight", publishAttempts: 0, publishStepCount: 0 });
  args.profile.capture();
  await reviewVerdict({
    pool,
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    headSha,
    leaseEpoch,
    commitStatusEnabled,
    summaryCommentId: lightweightResult.published ? lightweightResult.summaryId : null,
  }).close(
    lightweightResult.published
      ? { kind: "published", findings: [], summary: "Documentation-only change set." }
      : { kind: "cancelled", summary: "Review was cancelled before lightweight completion." },
  );
  return { done: true, result: { kind: "completed" } };
}

async function buildPriorInlineFeedbackPromise(args: {
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly cfg: Config;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly prSurface: PrSurface;
}): Promise<SettledPriorInlineFeedback> {
  const { cfg, item, reviewLens, prSurface } = args;
  const logPriorFeedbackError = (error: unknown) => {
    logWarn("prior_inline_feedback_fetch_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      reviewLens,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  try {
    const bot = await args.getBotIdentity();
    return {
      ok: true,
      value: await fetchPriorInlineFeedbackBlockForReview({
        prSurface,
        botUserId: bot.userId,
        reviewLens,
        maintainerDecisionAssociations: cfg.maintainerDecisionAssociations,
        onPriorFeedbackError: logPriorFeedbackError,
      }),
    };
  } catch (error: unknown) {
    logPriorFeedbackError(error);
    return { ok: false, error };
  }
}

type ReviewProfileRecord = {
  readonly outcome: WorkCompletedOutcome;
  readonly lastFailure?: ReturnType<typeof classifyFailure>;
  readonly publishAttempts?: number;
  readonly publishStepCount?: number;
};

type ReviewProfileSession = {
  record(record: ReviewProfileRecord): void;
  capture(): Extract<WorkCompletion, { kind: "review-profile" }> | undefined;
};

function createReviewProfileSession(args: {
  readonly cfg: Pick<Config, "piProvider" | "piModel">;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly getClaim: () => ReviewWorkClaim | undefined;
}): ReviewProfileSession {
  let pending: ReviewProfileRecord | undefined;
  let captured: Extract<WorkCompletion, { kind: "review-profile" }> | undefined;
  return {
    record(record) {
      if (pending || captured) return;
      pending = record;
    },
    capture() {
      if (captured || !pending) return captured;
      const snapshot = snapshotReviewRunMetrics();
      const claim = args.getClaim();
      const publishAttempts = pending.publishAttempts ?? snapshot?.publishAttempts ?? 0;
      const publishStepCount = pending.publishStepCount ?? snapshot?.publishStepCount ?? 0;
      const fields = reviewProfileFields({
        snapshot,
        provider: args.cfg.piProvider,
        model: args.cfg.piModel,
        reviewLens: args.reviewLens,
        source: args.payload.source,
      });
      const base = {
        kind: "review-profile" as const,
        durationMs: durationMsFromClaim(claim),
        attemptCount: claim?.attemptCount ?? args.item.attemptCount,
        publish: { publishAttempts, publishStepCount },
        ...fields,
      };
      switch (pending.outcome) {
        case "degraded":
          captured = {
            ...base,
            outcome: "degraded",
            degradedReason:
              degradedReasonFromReviewFlags({ publishAttempts, snapshot }) ?? "publish_retry",
          };
          break;
        case "failed":
          captured = {
            ...base,
            outcome: "failed",
            failure: pending.lastFailure
              ? workFailureReasonFromClassified(pending.lastFailure)
              : { failureDomain: "unknown", errorKind: "unknown" },
          };
          break;
        case "published":
        case "superseded":
        case "lightweight":
          captured = { ...base, outcome: pending.outcome };
          break;
        default: {
          const exhaustive: never = pending.outcome;
          return exhaustive;
        }
      }
      return captured;
    },
  };
}

async function handleReviewPublishResult(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly prSurface: PrSurface;
  readonly leaseEpoch: number | null;
  readonly commitStatusEnabled: boolean;
  readonly result: ReviewRunResult;
  readonly profile: ReviewProfileSession;
}): Promise<DurableExecutionResult> {
  const { pool, item, reviewLens, prSurface, leaseEpoch, commitStatusEnabled, result } = args;
  const snapshot = snapshotReviewRunMetrics();
  const outcome = reviewWorkOutcome({
    published: result.published,
    publishSuperseded: result.publishSuperseded,
    publishAttempts: result.publishAttempts,
    snapshot,
  });
  if (!result.published) {
    if (result.publishSuperseded) {
      logInfo("review_publish_superseded", {
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
        publishAttempts: result.publishAttempts,
      });
      args.profile.record({
        outcome,
        publishAttempts: result.publishAttempts,
        publishStepCount: result.publishStepCount,
      });
      await closeStoredReviewVerdict({
        pool,
        item,
        reviewLens,
        prSurface,
        leaseEpoch,
        commitStatusEnabled,
        outcome: { kind: "superseded" },
      });
    } else {
      const lastFailure =
        result.lastFailure ??
        snapshot?.lastFailure ??
        classifyFailure(new Error("Review was not published"), { phase: "publish" });
      logWarn("review_not_published", {
        owner: item.owner,
        repo: item.repo,
        pr: item.prNumber,
        publishAttempts: result.publishAttempts,
        publishDegraded: true,
        ...classifiedFailureLogFields(lastFailure),
      });
      args.profile.record({
        outcome,
        lastFailure,
        publishAttempts: result.publishAttempts,
        publishStepCount: result.publishStepCount,
      });
      await closeStoredReviewVerdict({
        pool,
        item,
        reviewLens,
        prSurface,
        leaseEpoch,
        commitStatusEnabled,
        outcome: { kind: "not_published" },
        lastFailure,
      });
    }
  } else {
    args.profile.record({
      outcome,
      publishAttempts: result.publishAttempts,
      publishStepCount: result.publishStepCount,
    });
    await closeStoredReviewVerdict({
      pool,
      item,
      reviewLens,
      prSurface,
      leaseEpoch,
      commitStatusEnabled,
      outcome:
        result.coverage?.kind === "partial"
          ? { kind: "partial", note: result.coverage.note }
          : { kind: "published", findings: result.publishedFindings ?? [] },
    });
  }
  if (result.published || result.publishSuperseded) {
    return { kind: "completed" };
  }
  return {
    kind: "completed",
    degradation: ["publish_not_completed"] satisfies readonly ReviewDegradationReason[],
  };
}

/**
 * Trusted-context assembly. Repository policy and agent instruction files are
 * read from the pinned checkout under their own byte caps; fork heads render as
 * untrusted evidence inside the loaders.
 */
async function assembleTrustedReviewContext(args: {
  readonly repositoryView: PrRepositoryView;
  readonly pullRequest: PullRequestForFileList | undefined;
  readonly priorInlineFeedback: string | undefined;
  readonly findingHistoryTrustedBlock: string | undefined;
  readonly checkoutCoverage: ReturnType<PrRepositoryView["workspace"]["reader"]["getCoverage"]>;
  readonly codeIndexStatus: Awaited<ReturnType<typeof prepareCodeIndexForReview>>;
}) {
  const {
    repositoryView,
    pullRequest,
    priorInlineFeedback,
    findingHistoryTrustedBlock,
    checkoutCoverage,
    codeIndexStatus,
  } = args;
  const changedFiles = (repositoryView.preflight.files ?? []).map((file) => file.filename);
  const sameRepo = isSameRepoPullRequest(pullRequest);
  const [repoPolicy, instructionFiles] = await Promise.all([
    loadRepoPolicy(repositoryView.agentCwd, MAX_REPO_POLICY_BYTES),
    loadAgentInstructionFiles(repositoryView.agentCwd, MAX_AGENT_INSTRUCTION_BYTES),
  ]);
  const agentInstructionFilesBlock =
    instructionFiles.kind === "ok"
      ? renderAgentInstructionFilesBlock({ files: instructionFiles.files, sameRepo }) || undefined
      : undefined;

  if (repoPolicy.kind === "invalid") {
    logWarn("repo_policy_invalid", {
      path: join(repositoryView.agentCwd, REPO_POLICY_DIRNAME),
      reason: repoPolicy.reason,
    });
  }
  const repoPolicyBlock =
    repoPolicy.kind === "ok"
      ? renderRepoPolicyBlock({
          policy: repoPolicy.policy,
          changedFiles,
          sameRepo,
        }) || undefined
      : undefined;

  const trustedContext = buildTrustedReviewContextForReview({
    preflight: repositoryView.preflight,
    priorInlineFeedback,
    findingHistoryTrustedBlock,
    repoPolicyBlock,
    agentInstructionFilesBlock,
    checkoutCoverage,
    symbolIndexStatus: repositoryView.workspace.reader.getSymbolIndexStatus(),
    codeIndexStatus,
  });
  return { sameRepo, repoPolicy, trustedContext };
}

async function runFullReviewAgainstRepositoryView(args: {
  readonly createSession: typeof createFeaturePiSession;
  readonly env: DurableExecutionContext;
  readonly job: JobWithMetadata<{ workItemId: string }>;
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly pullRequest: PullRequestForFileList | undefined;
  readonly publishContext: ReviewExecutorPublishContext;
  readonly crossPrSuppressionFingerprints: readonly string[];
  readonly findingHistoryTrustedBlock?: string;
  readonly publishAbortState: { staleHead?: boolean };
  readonly staleHeadAtPublish: { value: boolean };
  readonly priorInlineFeedback: Promise<SettledPriorInlineFeedback>;
  readonly repositoryView: PrRepositoryView;
  readonly leaseEpoch: number | null;
  readonly commitStatusEnabled: boolean;
  readonly signal: AbortSignal;
  readonly profile: ReviewProfileSession;
  readonly escalation?: EscalationPlan;
}): Promise<DurableExecutionResult> {
  const {
    createSession,
    cfg,
    pool,
    boss,
    item,
    reviewLens,
    payload,
    prSurface,
    headSha,
    pullRequest,
    publishContext,
    crossPrSuppressionFingerprints,
    findingHistoryTrustedBlock,
    publishAbortState,
    staleHeadAtPublish,
    priorInlineFeedback,
    repositoryView,
    leaseEpoch,
    commitStatusEnabled,
    signal,
    profile,
    escalation,
  } = args;
  const {
    publishState,
    shouldLinkToSummary,
    storedInlineFingerprints,
    resumedPlacements,
    progressCommentGithubId: progressCommentIdHint,
  } = publishContext;

  const priorInlineFeedbackResult = await priorInlineFeedback;
  if (!priorInlineFeedbackResult.ok) throw priorInlineFeedbackResult.error;

  const checkoutCoverage = repositoryView.workspace.reader.getCoverage();
  const agentEventsContext = resolveAgentEventsContext(cfg, {
    pool,
    workItemId: item.id,
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
  });
  if (agentEventsContext) {
    safeEmitCoverageEvent(agentEventsContext, cfg, {
      coverageMode: checkoutCoverage.mode,
      pathsInCheckout: checkoutCoverage.pathsInCheckout,
      truncated: checkoutCoverage.changeSetTruncated,
    });
  }

  const pathGate = createAskPathGate();
  pathGate.addPaths(repositoryView.workspace.reader.changedFiles.map((file) => file.path));
  const codeIndexStatus = await prepareCodeIndexForReview({
    cfg,
    pool,
    boss,
    scope: {
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
      headSha,
      prNumber: item.prNumber,
    },
    workspace: repositoryView.workspace,
    pathGate,
  });

  const { sameRepo, repoPolicy, trustedContext } = await assembleTrustedReviewContext({
    repositoryView,
    pullRequest,
    priorInlineFeedback: priorInlineFeedbackResult.value,
    findingHistoryTrustedBlock,
    checkoutCoverage,
    codeIndexStatus,
  });

  const timing = reviewRunTimingFromJob(args.job);
  const gate = reviewRunGate({
    pool,
    item,
    headSha,
    timing,
    prSurface,
    publishAbortState,
    staleHeadAtPublish,
  });
  const result = await runOrchestratedPrReview({
    cfg,
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha,
    mode: reviewLens,
    userSupplement: payload.userSupplement,
    trustedContext,
    storedInlineFingerprints,
    crossPrSuppressionFingerprints,
    workItemId: item.id,
    resumedPlacements,
    cwd: repositoryView.agentCwd,
    workspace: repositoryView.workspace,
    codeIndexSnapshotId: codeIndexStatus.available ? codeIndexStatus.snapshotId : undefined,
    sameRepo,
    repoPolicy,
    shouldLinkToSummary,
    progressCommentIdHint,
    hasDescriptionReviewMap: prBodyHasDescriptionReviewMap(pullRequest?.body),
    initialPublishState: {
      published: publishState.summaryPublished,
      inlineReviewIds: publishState.inlineReviewIds,
      threadCallCount: publishState.threadCallCount,
    },
    recordPublishStep: attachSummaryCommentCoordination(
      (step, detail) =>
        createPublishContext(pool, {
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          step,
          githubId: detail?.githubId,
          detail: detail?.meta,
          leaseEpoch,
        }).record(),
      {
        pool,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        leaseEpoch,
      },
    ),
    reviewSource: payload.source,
    staleHeadRescheduled: payload.staleHeadRescheduled,
    publishAbortState,
    timing,
    gate,
    prTitle: pullRequest?.title ?? "",
    prBody: pullRequest?.body ?? null,
    shouldAbortPublish: async () => {
      if (await args.env.shouldAbortPublish()) return true;
      const latestHeadSha = await prSurface.getHeadSha();
      if (latestHeadSha !== headSha) {
        staleHeadAtPublish.value = true;
        publishAbortState.staleHead = true;
        return true;
      }
      return false;
    },
    boss,
    sessionContext: args.env.durability,
    signal,
    escalation,
    createSession,
  });

  if (staleHeadAtPublish.value) {
    if (payload.staleHeadRescheduled) {
      throw staleHeadReplacementExhaustedError(item);
    }
    if (payload.source === "slash" || payload.source === "auto") {
      const reschedule = await scheduleStaleHeadReplacement({
        pool,
        item,
        leaseEpoch,
        beforeBuild: async () => {
          await closeStoredReviewVerdict({
            pool,
            item,
            reviewLens,
            prSurface,
            leaseEpoch,
            commitStatusEnabled,
            outcome: { kind: "stale_head" },
          });
        },
      });
      if (reschedule) return reschedule;
    }
  }

  return handleReviewPublishResult({
    pool,
    item,
    reviewLens,
    prSurface,
    leaseEpoch,
    commitStatusEnabled,
    result,
    profile,
  });
}

async function runClaimedReview(args: {
  readonly createSession: typeof createFeaturePiSession;
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly job: JobWithMetadata<{ workItemId: string }>;
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly env: DurableExecutionContext;
  readonly profile: ReviewProfileSession;
}): Promise<DurableExecutionResult> {
  const { job, cfg, pool, boss, item, reviewLens, payload, env, profile } = args;
  const commitStatusEnabled = cfg.features.commitStatus;
  const staleHeadResult = await handleStaleHeadReschedule({
    pool,
    item,
    reviewLens,
    payload,
    prSurface: env.prSurface,
    leaseEpoch: env.leaseEpoch,
    commitStatusEnabled,
  });
  if (staleHeadResult) return staleHeadResult;

  const [publishContext, crossPrSuppressionFingerprints, findingHistoryCandidates] =
    await recordReviewPhaseSpan("db-read", () =>
      Promise.all([
        loadReviewExecutorPublishContext(pool, item.id, item.resourceKey, reviewLens),
        safeLoadCrossPrSuppressionFingerprints(pool, cfg, {
          installationId: item.installationId,
          owner: item.owner,
          repo: item.repo,
        }),
        safeLoadFindingHistoryCandidates(pool, cfg, {
          installationId: item.installationId,
          owner: item.owner,
          repo: item.repo,
        }),
      ]),
    );
  const findingHistoryTrustedBlock = formatFindingHistoryTrustedBlock(
    findingHistoryCandidates,
    cfg.findingHistoryDismissSuppressAfter,
  );
  const prSurface = env.prSurface;
  const headSha = env.headSha;
  const staleHeadAtPublish = { value: false };
  const publishAbortState: { staleHead?: boolean } = {};

  await reviewVerdict({
    pool,
    commitStatusEnabled: cfg.features.commitStatus,
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    leaseEpoch: env.leaseEpoch,
    signal: env.signal,
  }).pending();

  if (publishContext.publishState.summaryPublished) {
    const summaryDetail = await createPublishContext(pool, {
      workItemId: item.id,
      resourceKey: item.resourceKey,
      reviewLens: reviewLens,
    }).completed("summary_comment");
    if (summaryDetail?.lightweightCompletion === true) {
      await closeStoredReviewVerdict({
        pool,
        item,
        reviewLens,
        prSurface,
        leaseEpoch: env.leaseEpoch,
        commitStatusEnabled,
        outcome: ownVerdictFromSummaryDetail(summaryDetail),
      });
      return { kind: "completed" };
    }
  }

  const lightweight = await runLightweightCompletionOrSkip({
    beginAttempt: env.beginAttempt,
    cfg,
    pool,
    boss,
    item,
    reviewLens,
    payload,
    prSurface,
    headSha,
    leaseEpoch: env.leaseEpoch,
    commitStatusEnabled,
    profile,
  });
  if (lightweight.done) return lightweight.result;

  const priorInlineFeedback = buildPriorInlineFeedbackPromise({
    getBotIdentity: args.getBotIdentity,
    cfg,
    item,
    reviewLens,
    prSurface,
  });

  const rateLimitCircuit = await openRunRateLimitCircuit({
    pool,
    installationId: item.installationId,
    type: "review",
    workItemId: item.id,
    onOpened: () => recordReviewMetric({ kind: "rate_limit_circuit_opened" }),
  });
  return runWithRateLimitCircuit(rateLimitCircuit, () =>
    env.withAdmittedRepositoryView(
      {
        repositorySizeKb: payload.repositorySizeKb,
        ...(lightweight.prefetchedPrFiles !== undefined
          ? { prFiles: lightweight.prefetchedPrFiles }
          : {}),
      },
      async (repositoryView) =>
        runFullReviewAgainstRepositoryView({
          createSession: args.createSession,
          env,
          job,
          cfg,
          pool,
          boss,
          item,
          reviewLens,
          payload,
          prSurface,
          headSha,
          pullRequest: env.pullRequest,
          publishContext,
          crossPrSuppressionFingerprints,
          findingHistoryTrustedBlock,
          publishAbortState,
          staleHeadAtPublish,
          priorInlineFeedback,
          repositoryView,
          leaseEpoch: env.leaseEpoch,
          commitStatusEnabled,
          signal: env.signal,
          profile,
          escalation: env.escalation,
        }),
    ),
  );
}

export type ReviewRunDependencies = {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly getBotIdentity: () => Promise<BotIdentity>;
  readonly createSession: typeof createFeaturePiSession;
};

/** Feature entry for one claimed review work item. */
export async function runReviewForWorkItem(
  item: ReviewWorkItem,
  env: DurableExecutionContext,
  deps: ReviewRunDependencies,
): Promise<DurableExecutionResult> {
  const { cfg, pool, boss } = deps;
  const reviewLens = item.reviewLens;
  const payload = item.payload;
  // Wall-clock starts at worker start (now), never at progress-stub post (queue wait).
  initReviewRunMetrics({
    provider: cfg.piProvider,
    model: cfg.piModel,
    mode: reviewLens,
  });
  const profile = createReviewProfileSession({
    cfg,
    item,
    reviewLens,
    payload,
    getClaim: () => env.claim,
  });
  const result = await runClaimedReview({
    createSession: deps.createSession,
    getBotIdentity: deps.getBotIdentity,
    job: env.job,
    cfg,
    pool,
    boss,
    item,
    reviewLens,
    payload,
    env,
    profile,
  });
  const completion = profile.capture();
  return result.kind === "completed" && completion ? { ...result, completion } : result;
}

type ReviewWorkClaim = {
  readonly createdAt: Date;
  readonly startedAt: Date;
  readonly attemptCount: number;
};

function reviewProfileFields(input: {
  readonly snapshot: ReviewRunMetricsSnapshot | null;
  readonly provider: string;
  readonly model: string;
  readonly reviewLens: string;
  readonly source: "auto" | "slash";
}): ReviewProfileFields {
  return {
    model: input.model,
    provider: input.provider,
    reviewLens: input.reviewLens,
    source: input.source,
    ...(input.snapshot
      ? {
          findingsCount: input.snapshot.findingsCount,
          specialistReport: input.snapshot.specialistOutcomes?.report ?? 0,
          specialistEmpty: input.snapshot.specialistOutcomes?.empty ?? 0,
          specialistError: input.snapshot.specialistOutcomes?.error ?? 0,
        }
      : {}),
  };
}
