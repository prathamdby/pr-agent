import { join } from "node:path";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../../config.js";
import { captureEvent } from "../../analytics/index.js";
import { classifyFailure, classifiedFailureLogFields } from "../../errors/classifiedFailure.js";
import type { PrSurface } from "../../github/prSurface.js";
import { createRateLimitCircuit, runWithRateLimitCircuit } from "../../github/rateLimitCircuit.js";
import {
  getSharedRateLimitCircuit,
  openSharedRateLimitCircuitBestEffort,
} from "../../github/sharedRateLimitCircuit.js";
import {
  assertPullRequestFilesHeadSha,
  type ListPullRequestFilesResult,
  type PullRequestForFileList,
} from "../../github/listPullRequestFiles.js";
import { runOrchestratedPrReview } from "../../review/orchestrator/orchestratorRun.js";
import type { ReviewRunResult } from "../../review/run/reviewRunTypes.js";
import type {
  ReviewRunGate,
  ReviewRunTiming,
} from "../../review/orchestrator/orchestratorTypes.js";
import { loadRepoPolicy, renderRepoPolicyBlock } from "../../review/repoPolicy.js";
import {
  isSameRepoPullRequest,
  loadAgentInstructionFiles,
  renderAgentInstructionFilesBlock,
} from "../../review/agentInstructionFiles.js";
import {
  buildTrustedReviewContextForReview,
  fetchPriorInlineFeedbackBlockForReview,
} from "../../review/prompts/reviewTrustedContext.js";
import {
  resolveAgentEventsContext,
  safeEmitCoverageEvent,
} from "../../agent/runtime/agentEventSink.js";
import { buildReviewPreflightMetadataFromPullRequestFiles } from "../../review/placement/reviewPreflightFiles.js";
import { REVIEW_SUMMARY_SENTINEL, type ReviewMode } from "../../review/reviewSchema.js";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  recordReviewMetric,
  recordReviewPhaseSpan,
  setReviewRunMetricFields,
  snapshotReviewRunMetrics,
} from "../../review/run/reviewRunMetrics.js";
import {
  reviewProfilerFailureProperties,
  reviewProfilerOutcome,
  reviewProfilerProperties,
  type ReviewProfilerOutcome,
  type ReviewWorkClaim,
} from "../../review/run/reviewProfiler.js";
import { logInfo, logWarn } from "../../evlog.js";
import { attachSummaryCommentCoordination } from "../../review/publish/publishReview.js";
import { withPrRepositoryView } from "../../prWorkspace/index.js";
import type { PrRepositoryView } from "../../prWorkspace/prRepositoryView.js";
import { prBodyHasDescriptionReviewMap } from "../../agent/description/descriptionRender.js";
import {
  MAX_REPO_POLICY_BYTES,
  MAX_AGENT_INSTRUCTION_BYTES,
  REPO_POLICY_DIRNAME,
  MAX_PR_FILES_LISTED,
  MAX_PR_FILES_PATCH_BYTES,
  REVIEW_FINALIZATION_WINDOW_MS,
} from "../../settings/index.js";
import { tryLightweightAutoReviewCompletion } from "../reviewLightweightCompletion.js";
import {
  cancelReviewCheckRun,
  completeReviewCheckRun,
  ensureReviewCheckRunStarted,
  reviewCheckDetailsUrl,
} from "../reviewCheckRun.js";
import {
  formatFindingHistoryTrustedBlock,
  safeLoadCrossPrSuppressionFingerprints,
  safeLoadFindingHistoryCandidates,
} from "../findingHistoryRepository.js";
import {
  hasCompletedPublishStep,
  loadReviewExecutorPublishContext,
  getSummaryCommentGithubId,
  getWorkItem,
  recordPublishStep,
  shouldSkipWork,
  type ReviewExecutorPublishContext,
} from "../repository.js";
import { isPrActorLeaseHeld } from "../prActorLease.js";
import { REVIEW_QUEUE } from "../../settings/index.js";
import {
  staleHeadReplacementExhaustedError,
  tryBuildStaleReviewRescheduleResult,
  type StaleReviewRescheduleResult,
} from "../reviewReschedule.js";
import { renderReviewFailureNotice } from "../../review/run/progressComment.js";
import {
  resolveWorkItemHead,
  runDurableWorkItem,
  type DurableHeadResolution,
  type DurableExecutionContext,
  type DurableExecutionResult,
} from "../durableJob.js";
import { getAppBotIdentity } from "../../github/appAuth.js";
import { type ReviewJobData, type ReviewWorkItem, type ReviewWorkPayload } from "../types.js";
import { buildRepositoryViewParams } from "./repositoryViewParams.js";
import { createAskPathGate } from "../../agent/ask/askSafety.js";
import { prepareCodeIndexForReview } from "../../codeIndex/buildJob.js";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

type SettledPriorInlineFeedback = Result<string | undefined>;

/** Load a discriminated result and render the ok branch into a trusted-context block. */
async function loadAndRenderTrustedBlock<TResult extends { readonly kind: string }>(params: {
  readonly load: () => Promise<TResult>;
  readonly renderOk: (result: Extract<TResult, { kind: "ok" }>) => string;
  readonly onNonOk?: (result: Exclude<TResult, { kind: "ok" }>) => void;
}): Promise<string | undefined> {
  const result = await params.load();
  if (result.kind === "ok") {
    return params.renderOk(result as Extract<TResult, { kind: "ok" }>) || undefined;
  }
  params.onNonOk?.(result as Exclude<TResult, { kind: "ok" }>);
  return undefined;
}

type ReviewExecutionResult = DurableExecutionResult;

type LightweightPhaseResult =
  | { readonly done: true; readonly result: ReviewExecutionResult }
  | { readonly done: false; readonly prefetchedPrFiles: ListPullRequestFilesResult | undefined };

function reviewRunTimingFromJob(job: JobWithMetadata<ReviewJobData>): ReviewRunTiming {
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

/**
 * Automated work items already persist the head SHA, but not the PR identity
 * needed for trust decisions. Read the current PR metadata without replacing
 * the queued SHA; stale-head handling remains responsible for that contract.
 */
async function resolveReviewHead(
  prSurface: PrSurface,
  item: ReviewWorkItem,
): Promise<DurableHeadResolution> {
  const resolved = await resolveWorkItemHead(prSurface, item);
  if (resolved.pullRequest != null) return resolved;

  try {
    const current = await prSurface.getHead();
    return { headSha: resolved.headSha, pullRequest: current.pullRequest };
  } catch (error) {
    logWarn("review_pr_identity_fetch_failed", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    return resolved;
  }
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
  readonly beforeBuild?: () => Promise<void>;
}): Promise<StaleReviewRescheduleResult | undefined> {
  if (await shouldSkipWork(args.pool, args.item)) {
    return undefined;
  }
  await args.beforeBuild?.();
  return (await tryBuildStaleReviewRescheduleResult(args.pool, args.item)) ?? undefined;
}

/** Resume a parent that already persisted a replacement marker but has not finished enqueue. */
async function handleStaleHeadReschedule(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly prSurface: PrSurface;
  readonly leaseEpoch: number | null;
}): Promise<StaleReviewRescheduleResult | undefined> {
  const { pool, item, reviewLens, payload, prSurface, leaseEpoch } = args;
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
    beforeBuild: async () => {
      await completeReviewCheckRun(pool, {
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        leaseEpoch,
        conclusion: "cancelled",
        summary: "Review was rescheduled for a newer pull request head.",
      });
    },
  });
}

async function completeCheckFromStoredSummary(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly prSurface: PrSurface;
  readonly leaseEpoch: number | null;
  readonly conclusion: "failure" | "cancelled";
  readonly summary: string;
  readonly lastFailure?: ReviewRunResult["lastFailure"];
}): Promise<void> {
  const { pool, item, reviewLens, prSurface, leaseEpoch, conclusion, summary, lastFailure } = args;
  if (conclusion === "failure" && lastFailure != null) {
    logWarn("review_check_run_failure_classified", {
      owner: item.owner,
      repo: item.repo,
      pr: item.prNumber,
      ...classifiedFailureLogFields(lastFailure),
    });
  }
  const summaryCommentId = await getSummaryCommentGithubId(pool, item.resourceKey, reviewLens);
  await completeReviewCheckRun(pool, {
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    leaseEpoch,
    conclusion,
    summary,
    detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summaryCommentId),
  });
}

async function runLightweightCompletionOrSkip(args: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly prSurface: PrSurface;
  readonly headSha: string;
  readonly leaseEpoch: number | null;
  readonly profile: ReviewProfileSession;
}): Promise<LightweightPhaseResult> {
  const { cfg, pool, item, reviewLens, payload, prSurface, headSha, leaseEpoch } = args;
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
  assertPullRequestFilesHeadSha(prefetchedPrFiles, headSha);
  const preflight = buildReviewPreflightMetadataFromPullRequestFiles(prefetchedPrFiles);
  const lightweightResult = await tryLightweightAutoReviewCompletion(pool, {
    item,
    reviewLens,
    prSurface,
    preflight,
    model: cfg.piModel,
    leaseEpoch,
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
  args.profile.record({ outcome: "lightweight", publishAttempts: 0 });
  await completeReviewCheckRun(pool, {
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    leaseEpoch,
    conclusion: lightweightResult.published ? "success" : "cancelled",
    summary: lightweightResult.published
      ? "Documentation-only change set."
      : "Review was cancelled before lightweight completion.",
    detailsUrl: reviewCheckDetailsUrl(
      item.owner,
      item.repo,
      item.prNumber,
      lightweightResult.published ? lightweightResult.summaryId : null,
    ),
  });
  return { done: true, result: { kind: "completed" } };
}

async function buildPriorInlineFeedbackPromise(args: {
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
    const bot = await getAppBotIdentity(cfg);
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
  readonly outcome: ReviewProfilerOutcome;
  readonly lastFailure?: ReturnType<typeof classifyFailure>;
  readonly publishAttempts?: number;
};

type ReviewProfileSession = {
  record(record: ReviewProfileRecord): void;
  flush(): void;
};

function createReviewProfileSession(args: {
  readonly cfg: Pick<Config, "piProvider" | "piModel">;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly claim?: ReviewWorkClaim;
}): ReviewProfileSession {
  let pending: ReviewProfileRecord | undefined;
  let flushed = false;
  return {
    record(record) {
      if (pending || flushed) return;
      pending = record;
    },
    flush() {
      if (flushed || !pending) return;
      flushed = true;
      const snapshot = snapshotReviewRunMetrics();
      captureEvent({
        distinctId: `installation:${args.item.installationId}`,
        event: "review profiled",
        properties: {
          work_item_id: args.item.id,
          owner: args.item.owner,
          repo: args.item.repo,
          pr_number: args.item.prNumber,
          review_lens: args.reviewLens,
          source: args.payload.source,
          outcome: pending.outcome,
          ...reviewProfilerProperties({
            snapshot,
            cfg: args.cfg,
            claim: args.claim,
            publishAttempts: pending.publishAttempts,
          }),
          ...(pending.lastFailure ? reviewProfilerFailureProperties(pending.lastFailure) : {}),
        },
      });
    },
  };
}

async function handleReviewPublishResult(args: {
  readonly pool: Pool;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly prSurface: PrSurface;
  readonly leaseEpoch: number | null;
  readonly result: ReviewRunResult;
  readonly profile: ReviewProfileSession;
}): Promise<ReviewExecutionResult> {
  const { pool, item, reviewLens, prSurface, leaseEpoch, result } = args;
  const snapshot = snapshotReviewRunMetrics();
  const outcome = reviewProfilerOutcome({
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
      args.profile.record({ outcome, publishAttempts: result.publishAttempts });
      await completeCheckFromStoredSummary({
        pool,
        item,
        reviewLens,
        prSurface,
        leaseEpoch,
        conclusion: "cancelled",
        summary: "Review publish was skipped because the work was superseded or cancelled.",
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
      });
      await completeCheckFromStoredSummary({
        pool,
        item,
        reviewLens,
        prSurface,
        leaseEpoch,
        conclusion: "failure",
        summary: "PR Agent could not publish a structured review.",
        lastFailure,
      });
    }
  } else {
    args.profile.record({ outcome, publishAttempts: result.publishAttempts });
  }
  return {
    kind: "completed",
    degraded: !result.published && !result.publishSuperseded,
  };
}

async function runFullReviewAgainstRepositoryView(args: {
  readonly job: JobWithMetadata<ReviewJobData>;
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
  readonly signal: AbortSignal;
  readonly profile: ReviewProfileSession;
}): Promise<ReviewExecutionResult> {
  const {
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
    signal,
    profile,
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

  const checkoutCoverage = repositoryView.workspace.getCoverage();
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
  pathGate.addPaths(repositoryView.workspace.changedFiles.map((file) => file.path));
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

  const changedFiles = (repositoryView.preflight.files ?? []).map((file) => file.filename);
  const sameRepo = isSameRepoPullRequest(pullRequest);
  const [repoPolicy, agentInstructionFilesBlock] = await Promise.all([
    loadRepoPolicy(repositoryView.agentCwd, MAX_REPO_POLICY_BYTES),
    loadAndRenderTrustedBlock({
      load: () => loadAgentInstructionFiles(repositoryView.agentCwd, MAX_AGENT_INSTRUCTION_BYTES),
      renderOk: (result) =>
        renderAgentInstructionFilesBlock({
          files: result.files,
          sameRepo,
        }),
    }),
  ]);
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
    priorInlineFeedback: priorInlineFeedbackResult.value,
    findingHistoryTrustedBlock,
    repoPolicyBlock,
    agentInstructionFilesBlock,
    checkoutCoverage,
    symbolIndexStatus: repositoryView.workspace.getSymbolIndexStatus(),
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
    hasDescriptionReviewMap: prBodyHasDescriptionReviewMap(
      (pullRequest as { body?: string | null } | undefined)?.body,
    ),
    initialPublishState: {
      published: publishState.summaryPublished,
      inlineReviewIds: publishState.inlineReviewIds,
      threadCallCount: publishState.threadCallCount,
    },
    recordPublishStep: attachSummaryCommentCoordination(
      (step, detail) =>
        recordPublishStep(pool, {
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          step,
          githubId: detail?.githubId,
          detail: detail?.meta,
          leaseEpoch,
        }),
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
    prTitle: (pullRequest as { title?: string } | undefined)?.title ?? "",
    prBody: (pullRequest as { body?: string | null } | undefined)?.body ?? null,
    shouldAbortPublish: async () => {
      if (signal.aborted) return true;
      if (await shouldSkipWork(pool, item)) return true;
      if (leaseEpoch != null && !(await isPrActorLeaseHeld(pool, item.id, leaseEpoch))) {
        return true;
      }
      const latestHeadSha = await prSurface.getHeadSha();
      if (latestHeadSha !== headSha) {
        staleHeadAtPublish.value = true;
        publishAbortState.staleHead = true;
        return true;
      }
      return false;
    },
    durability: {
      pool,
      workItemId: item.id,
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
    },
  });

  if (staleHeadAtPublish.value) {
    if (payload.staleHeadRescheduled) {
      throw staleHeadReplacementExhaustedError(item);
    }
    if (payload.source === "slash" || payload.source === "auto") {
      const reschedule = await scheduleStaleHeadReplacement({
        pool,
        item,
        beforeBuild: async () => {
          await completeCheckFromStoredSummary({
            pool,
            item,
            reviewLens,
            prSurface,
            leaseEpoch,
            conclusion: "cancelled",
            summary: "Review was rescheduled for a newer pull request head.",
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
    result,
    profile,
  });
}

async function runClaimedReview(args: {
  readonly job: JobWithMetadata<ReviewJobData>;
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly item: ReviewWorkItem;
  readonly reviewLens: ReviewMode;
  readonly payload: ReviewWorkPayload;
  readonly env: DurableExecutionContext;
  readonly profile: ReviewProfileSession;
}): Promise<ReviewExecutionResult> {
  const { job, cfg, pool, boss, item, reviewLens, payload, env, profile } = args;
  const staleHeadResult = await handleStaleHeadReschedule({
    pool,
    item,
    reviewLens,
    payload,
    prSurface: env.prSurface,
    leaseEpoch: env.leaseEpoch,
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

  await ensureReviewCheckRunStarted(pool, {
    prSurface,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    headSha,
    workItemId: item.id,
    resourceKey: item.resourceKey,
    reviewLens,
    leaseEpoch: env.leaseEpoch,
  });

  const lightweight = await runLightweightCompletionOrSkip({
    cfg,
    pool,
    item,
    reviewLens,
    payload,
    prSurface,
    headSha,
    leaseEpoch: env.leaseEpoch,
    profile,
  });
  if (lightweight.done) return lightweight.result;

  const priorInlineFeedback = buildPriorInlineFeedbackPromise({
    cfg,
    item,
    reviewLens,
    prSurface,
  });

  const rateLimitCircuit = createRateLimitCircuit({
    installationId: item.installationId,
    onOpened: (kind) => {
      recordReviewMetric({ kind: "rate_limit_circuit_opened" });
      openSharedRateLimitCircuitBestEffort(pool, {
        installationId: item.installationId,
        lastErrorKind: kind,
      });
    },
  });
  try {
    const sharedCircuit = await getSharedRateLimitCircuit(pool, item.installationId);
    if (sharedCircuit != null && sharedCircuit.openUntil.getTime() > Date.now()) {
      rateLimitCircuit.hydrateOpenFromShared(
        sharedCircuit.lastErrorKind === "secondary" ? "secondary" : "primary",
        sharedCircuit.openUntil,
      );
      logInfo("github_shared_rate_limit_circuit_honored", {
        installationId: item.installationId,
        type: "review",
        workItemId: item.id,
      });
    }
  } catch (error) {
    // Best-effort shared read: DB blips must not abort the review run.
    logWarn("github_shared_rate_limit_circuit_read_failed", {
      installationId: item.installationId,
      type: "review",
      workItemId: item.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return runWithRateLimitCircuit(rateLimitCircuit, () =>
    withPrRepositoryView(
      buildRepositoryViewParams(
        item,
        {
          gitCredentialAuth: () => prSurface.gitCredentialAuth(),
          headSha,
          pullRequest: env.pullRequest,
        },
        payload,
        { prFiles: lightweight.prefetchedPrFiles },
      ),
      async (repositoryView) =>
        runFullReviewAgainstRepositoryView({
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
          signal: env.signal,
          profile,
        }),
    ),
  );
}

export async function executeReviewJob(
  cfg: Config,
  pool: Pool,
  boss: PgBoss,
  job: JobWithMetadata<ReviewJobData>,
): Promise<void> {
  await runDurableWorkItem({
    cfg,
    pool,
    boss,
    job,
    type: "review",
    prActorLease: { queue: REVIEW_QUEUE },
    acceptItem: (item) => item.reviewLens != null,
    resolveHeadSha: resolveReviewHead,
    execute: async (item, env) => {
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
        claim: env.claim,
      });
      try {
        return await runClaimedReview({
          job,
          cfg,
          pool,
          boss,
          item,
          reviewLens,
          payload,
          env,
          profile,
        });
      } catch (error) {
        profile.record({
          outcome: "failed",
          lastFailure: classifyFailure(error),
        });
        throw error;
      } finally {
        profile.flush();
      }
    },
    onCancelled: async (item, prSurface, _reason, leaseEpoch) => {
      if (!item.reviewLens) return;
      const reviewLens = item.reviewLens;
      const summaryCommentId = await getSummaryCommentGithubId(pool, item.resourceKey, reviewLens);
      await cancelReviewCheckRun(pool, {
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        leaseEpoch,
        headSha: item.headSha,
        detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summaryCommentId),
      });
    },
    onTerminalFailure: async (item, prSurface, _error, leaseEpoch) => {
      if (!prSurface) return;
      const reviewLens = item.reviewLens;
      if (!reviewLens) return;
      if (
        await hasCompletedPublishStep(
          pool,
          item.id,
          item.resourceKey,
          reviewLens,
          "summary_comment",
        )
      ) {
        return;
      }
      const landedSummary = await prSurface.findProgressComment(REVIEW_SUMMARY_SENTINEL);
      if (landedSummary != null) return;
      const summary = await prSurface.upsertProgressComment(
        renderReviewFailureNotice({
          mode: reviewLens,
          retryCommand: "/review",
        }),
        REVIEW_SUMMARY_SENTINEL,
      );
      await completeReviewCheckRun(pool, {
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        leaseEpoch,
        conclusion: "failure",
        summary: "PR Agent could not complete the review after retries.",
        detailsUrl: reviewCheckDetailsUrl(item.owner, item.repo, item.prNumber, summary.id),
      });
    },
  });
}
