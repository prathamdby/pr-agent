import type { Config } from "../../config.js";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../../errors/appError.js";
import {
  operationIntentMarker,
  reviewCommitStatusOperationKey,
  reviewLabelsOperationKey,
  reviewSummaryOperationKey,
  withOperationIntent,
} from "../../agentWork/withOperationIntent.js";
import {
  claimSummaryCommentCreation,
  getProgressCommentOwner,
  getProgressCommentRevision,
  getProgressStubPostedAtMs,
  getSummaryCommentGithubId,
  recordPublishStep as recordAgentWorkPublishStep,
} from "../../agentWork/repository.js";
import {
  completeReviewCheckRun,
  reviewCheckDetailsUrl,
  reviewCheckRunOutcome,
} from "../../agentWork/reviewCheckRun.js";
import { logDebug, logWarn } from "../../evlog.js";
import type { PrSurface } from "../../github/prSurface.js";
import { findCommentIdByMarker } from "../../github/prSurfaceHelpers.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import {
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_WAIT_MS,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS,
  REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
} from "../../settings/index.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { buildCiSummaryForSurface } from "../ci/analyzeCi.js";
import type { CiSummaryAuthor } from "../ci/authorCiSummary.js";
import { preserveCiSummaryRowInCommentBody } from "../ci/renderCiSummary.js";
import type { FindingLedger, ReviewCoverage } from "../orchestrator/orchestratorTypes.js";
import { enrichPlacementsWithInlineCommentUrls } from "./placementEnrichment.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  dominantReviewCategory,
  hasManagedCategoryLabel,
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
} from "../run/reviewLabels.js";
import { renderReviewSummaryComment } from "../run/reviewRender.js";
import { resolveReviewWallClockMs } from "../run/reviewRunFooter.js";
import { snapshotReviewRunMetrics } from "../run/reviewRunMetrics.js";
import { parseProgressRevisionState, withProgressRevisionComment } from "../run/progressComment.js";
import {
  REVIEW_SUMMARY_SENTINEL,
  type ReviewPayload,
  type ReviewPublishContext,
} from "../reviewSchema.js";

export type SummaryCommentCoordination = {
  pool: Pool;
  workItemId: string;
  resourceKey: string;
  leaseEpoch?: number | null;
};

export type RecordPublishStepFn = (
  step: "inline_review" | "summary_comment" | "labels",
  detail?: { githubId?: string | number; meta?: Record<string, unknown> },
) => Promise<void>;

export type RecordPublishStepWithCoordination = RecordPublishStepFn & {
  summaryCommentCoordination?: SummaryCommentCoordination;
};

export function attachSummaryCommentCoordination(
  recordPublishStep: RecordPublishStepFn,
  coordination: SummaryCommentCoordination,
): RecordPublishStepWithCoordination {
  return Object.assign(recordPublishStep, { summaryCommentCoordination: coordination });
}

async function resolveKnownSummaryCommentRef(
  prSurface: PrSurface,
  sentinel: string,
  hintCommentId: number | null | undefined,
): Promise<{ id: number; url: string } | null> {
  const resolved = await prSurface.resolveProgressComment(sentinel, hintCommentId);
  return resolved ? { id: resolved.id, url: resolved.url } : null;
}

async function findSummaryCommentByOperationMarker(
  prSurface: PrSurface,
  marker: string,
): Promise<{ readonly id: number } | null> {
  const botLogin = await prSurface.getBotLogin?.();
  if (botLogin == null) return null;
  const comments = await prSurface.listConversationComments();
  const id = findCommentIdByMarker(comments, marker, (comment) => comment.authorLogin === botLogin);
  return id == null ? null : { id };
}

type ProgressCommentRevision = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

type SummaryCommentUpsertResult = {
  readonly id: number;
  readonly updated: boolean;
  readonly skipped?: true;
};

type SummaryCommentUpsertParams = {
  pool: Pool | PoolClient;
  workItemId?: string;
  leaseEpoch?: number | null;
  resourceKey: string;
  reviewLens: AnyReviewLens;
  prSurface: PrSurface;
  body: string;
  sentinel: string;
  hintCommentId?: number | null;
  progressRevision?: ProgressCommentRevision;
};

async function upsertSummaryCommentWithoutRevision(
  params: SummaryCommentUpsertParams,
): Promise<SummaryCommentUpsertResult> {
  const { pool, workItemId, resourceKey, reviewLens, prSurface, body, sentinel } = params;

  const storedId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
  const hintId = params.hintCommentId ?? storedId ?? null;
  const knownFromStored = await resolveKnownSummaryCommentRef(prSurface, sentinel, hintId);
  if (knownFromStored) {
    return prSurface.upsertProgressComment(body, sentinel, knownFromStored);
  }

  if (workItemId == null) {
    const scanned = await prSurface.findProgressComment(sentinel);
    return prSurface.upsertProgressComment(body, sentinel, scanned);
  }

  const claimWon =
    params.leaseEpoch == null
      ? await claimSummaryCommentCreation(pool, workItemId, resourceKey, reviewLens)
      : await claimSummaryCommentCreation(
          pool,
          workItemId,
          resourceKey,
          reviewLens,
          params.leaseEpoch,
        );
  if (claimWon) {
    const scanned = await prSurface.findProgressComment(sentinel);
    return prSurface.upsertProgressComment(body, sentinel, scanned);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay =
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ??
        REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS.at(-1) ??
        0;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    const polledId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
    if (polledId == null) continue;
    const knownFromPoll = await resolveKnownSummaryCommentRef(prSurface, sentinel, polledId);
    if (knownFromPoll) {
      return prSurface.upsertProgressComment(body, sentinel, knownFromPoll);
    }
  }

  const scanned = await prSurface.findProgressComment(sentinel);
  return prSurface.upsertProgressComment(body, sentinel, scanned);
}

async function upsertSummaryCommentAtRevision(
  params: Omit<SummaryCommentUpsertParams, "pool" | "progressRevision"> & {
    readonly progressRevision: ProgressCommentRevision;
  },
  client: PoolClient,
): Promise<SummaryCommentUpsertResult> {
  const [progressOwner, storedRevision, currentComment] = await Promise.all([
    getProgressCommentOwner(client, params.resourceKey, params.reviewLens),
    getProgressCommentRevision(client, params.resourceKey, params.reviewLens),
    params.prSurface.findProgressComment(params.sentinel),
  ]);
  const bodyRevision = currentComment
    ? parseProgressRevisionState(currentComment.body ?? "")
    : null;
  // Authoritative ownership lives on the progress publish record (reassigned at intake).
  // Stale writers whose work item no longer owns the record must not overwrite.
  if (
    progressOwner != null &&
    params.workItemId != null &&
    progressOwner.workItemId !== params.workItemId
  ) {
    if (currentComment) {
      return { id: currentComment.id, updated: false, skipped: true };
    }
    const hintId = params.hintCommentId;
    if (hintId != null) {
      return { id: hintId, updated: false, skipped: true };
    }
    logWarn("review_progress_skipped_foreign_owner", {
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      workItemId: params.workItemId,
      ownerWorkItemId: progressOwner.workItemId,
      progressGeneration: progressOwner.generation,
    });
    return { id: 0, updated: false, skipped: true };
  }
  const storedRevisionForRun =
    storedRevision != null && storedRevision.workItemId === params.workItemId
      ? storedRevision.revision
      : -1;
  const bodyRevisionForRun =
    bodyRevision != null && bodyRevision.workItemId === params.workItemId
      ? bodyRevision.revision
      : -1;
  const currentRevision = currentComment ? Math.max(storedRevisionForRun, bodyRevisionForRun) : -1;
  if (currentComment && currentRevision >= params.progressRevision) {
    return { id: currentComment.id, updated: false, skipped: true };
  }

  const stubPostedAtMs =
    params.workItemId != null && params.progressRevision === 0
      ? Date.now()
      : params.workItemId != null
        ? await getProgressStubPostedAtMs(client, params.resourceKey, params.reviewLens)
        : null;

  // Persist stubPostedAtMs before the GitHub comment upsert so it survives
  // even when the subsequent recordAgentWorkPublishStep call fails.
  if (params.workItemId != null && stubPostedAtMs != null) {
    await recordAgentWorkPublishStep(client, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      step: "progress_comment",
      detail: { stubPostedAtMs },
      leaseEpoch: params.leaseEpoch ?? null,
    });
  }

  const result = await upsertSummaryCommentWithoutRevision({
    ...params,
    pool: client,
    body: withProgressRevisionComment(
      preserveCiSummaryRowInCommentBody(currentComment?.body ?? "", params.body),
      params.progressRevision,
      params.workItemId,
    ),
    hintCommentId: currentComment?.id ?? params.hintCommentId,
  });
  if (params.workItemId != null) {
    await recordAgentWorkPublishStep(client, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      step: "progress_comment",
      githubId: result.id,
      leaseEpoch: params.leaseEpoch ?? null,
      detail: {
        progressRevision: params.progressRevision,
        updated: result.updated,
        ...(stubPostedAtMs != null ? { stubPostedAtMs } : {}),
      },
    });
  }
  return result;
}

export async function upsertSummaryCommentWithCreationClaim(
  params: Omit<SummaryCommentUpsertParams, "pool"> & { readonly pool: Pool },
): Promise<SummaryCommentUpsertResult> {
  if (params.progressRevision == null) {
    return upsertSummaryCommentWithoutRevision(params);
  }

  const client = await params.pool.connect();
  const lockKey = JSON.stringify([params.resourceKey, params.reviewLens]);
  let lockAcquired = false;
  let outcome:
    | { readonly kind: "success"; readonly value: SummaryCommentUpsertResult }
    | { readonly kind: "error"; readonly error: unknown };
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    lockAcquired = true;
    outcome = {
      kind: "success",
      value: await upsertSummaryCommentAtRevision(
        { ...params, progressRevision: params.progressRevision },
        client,
      ),
    };
  } catch (error) {
    outcome = { kind: "error", error };
  }

  let unlockError: unknown;
  if (lockAcquired) {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
    } catch (error) {
      unlockError = error;
      logWarn("review_progress_unlock_failed", {
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  client.release(unlockError === undefined ? undefined : true);
  if (outcome.kind === "error") throw outcome.error;
  if (unlockError !== undefined) throw unlockError;
  return outcome.value;
}

export type PublishSummaryOnlyResult =
  | { readonly kind: "published"; readonly summaryCommentId: number }
  | { readonly kind: "stopped"; readonly reason: "superseded" | "stale_head" };

export async function publishReviewSummaryOnly(params: {
  readonly cfg: Pick<Config, "piModel" | "features">;
  readonly ctx: ReviewPublishContext;
  readonly prSurface: PrSurface;
  readonly payload: ReviewPayload;
  readonly ledger: FindingLedger;
  readonly mode?: AnyReviewLens;
  readonly cachedDiffIndex?: CachedPrDiffIndex;
  readonly shouldLinkToSummary?: boolean;
  readonly progressCommentIdHint?: number | null;
  readonly staleReview?: boolean;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly ciAuthor?: CiSummaryAuthor;
  readonly coverage?: ReviewCoverage;
  readonly remainingFinalizationMs?: () => number;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly dedupedFindingCount?: number;
}): Promise<PublishSummaryOnlyResult> {
  const coverage = params.coverage ?? { kind: "full" };
  if (coverage.kind === "none") {
    throw new AppError({
      code: "review.summary_coverage_none",
      message: "Cannot publish a review summary when every specialist failed",
      context: { failedSpecialists: coverage.failed },
    });
  }
  const partialCoverageNote = coverage.kind === "partial" ? coverage.note : undefined;
  const { owner, repo, prNumber, headSha } = params.ctx;
  const mode = params.mode ?? "review";
  const summarySentinel = REVIEW_SUMMARY_SENTINEL;
  const summaryPlacements = params.ledger.accepted.map((accepted) => accepted.placement);
  // Prefer URLs already attached during inline publish; fetch the PR once for the rest.
  const placementsNeedingUrls = summaryPlacements.some(
    (placement) => placement.inlinePosted && placement.inlineCommentUrl == null,
  );
  let reviewComments: Awaited<ReturnType<PrSurface["listPullRequestReviewComments"]>>["comments"] =
    [];
  if (placementsNeedingUrls) {
    try {
      const listed = await params.prSurface.listPullRequestReviewComments();
      reviewComments = listed.comments;
      if (listed.truncated) {
        logWarn("review_inline_comment_urls_truncated", {
          mode,
          owner,
          repo,
          pr: prNumber,
          commentCount: listed.comments.length,
        });
      }
    } catch (error) {
      logWarn("review_inline_comment_urls_failed", {
        mode,
        owner,
        repo,
        pr: prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const enrichedPlacements = enrichPlacementsWithInlineCommentUrls(
    summaryPlacements,
    reviewComments,
  );

  const metricsSnapshot = snapshotReviewRunMetrics();
  const summaryCoordination = params.recordPublishStep?.summaryCommentCoordination;
  const ciSummary = await buildCiSummaryForSurface(params.prSurface, {
    headSha,
    waitMs: Math.max(
      0,
      Math.min(REVIEW_CI_SUMMARY_WAIT_MS, params.remainingFinalizationMs?.() ?? Infinity),
    ),
    waitPollMs: REVIEW_CI_SUMMARY_WAIT_POLL_MS,
    maxFailures: REVIEW_CI_SUMMARY_MAX_FAILURES,
    author: params.ciAuthor,
  });
  const durationMs = resolveReviewWallClockMs({
    metricsStartedAtMs: metricsSnapshot?.startedAtMs,
    endedAtMs: Date.now(),
  });
  const summaryBody = renderReviewSummaryComment(params.payload, {
    ...params.ctx,
    summarySentinel,
    placements: enrichedPlacements,
    mode,
    staleReview: params.staleReview ?? false,
    cachedDiffIndex: params.cachedDiffIndex,
    ciSummary,
    partialCoverageNote,
    runFooter: {
      durationMs,
      model: params.cfg.piModel,
    },
  });

  let shouldAbort = false;
  try {
    shouldAbort = (await params.shouldAbortPublish?.()) ?? false;
  } catch (error) {
    logWarn("review_summary_abort_check_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
    shouldAbort = true;
  }
  if (shouldAbort) {
    return {
      kind: "stopped",
      reason: params.publishAbortState?.staleHead === true ? "stale_head" : "superseded",
    };
  }

  let knownSummaryCommentRef: { id: number; url: string } | null = null;
  if (params.shouldLinkToSummary) {
    const resolvedSummary = await params.prSurface.resolveProgressComment(
      summarySentinel,
      params.progressCommentIdHint,
    );
    knownSummaryCommentRef = resolvedSummary
      ? { id: resolvedSummary.id, url: resolvedSummary.url }
      : null;
  }

  const labelsPromise = params.prSurface.getLabels().catch((error: unknown) => error);
  const coordination = summaryCoordination;
  const summaryOperationKey =
    coordination == null ? null : reviewSummaryOperationKey(coordination.resourceKey, mode);
  const summaryOperationMarker =
    coordination == null
      ? null
      : operationIntentMarker(
          reviewSummaryOperationKey(coordination.resourceKey, mode),
          coordination.workItemId,
        );
  const summaryBodyForPublish =
    summaryOperationMarker == null ? summaryBody : `${summaryBody}\n${summaryOperationMarker}`;
  const runSummaryUpsert = () =>
    summaryCoordination
      ? upsertSummaryCommentWithCreationClaim({
          ...summaryCoordination,
          reviewLens: mode,
          prSurface: params.prSurface,
          body: summaryBodyForPublish,
          sentinel: summarySentinel,
          hintCommentId: params.progressCommentIdHint ?? knownSummaryCommentRef?.id,
          progressRevision: 7,
        })
      : params.prSurface.upsertProgressComment(
          summaryBodyForPublish,
          summarySentinel,
          knownSummaryCommentRef,
        );
  const summaryPromise =
    summaryCoordination == null
      ? runSummaryUpsert()
      : withOperationIntent<{ readonly id: number; readonly updated: boolean }>({
          client: summaryCoordination.pool,
          workItemId: summaryCoordination.workItemId,
          operationKey:
            summaryOperationKey ?? reviewSummaryOperationKey(summaryCoordination.resourceKey, mode),
          mutationKind: "github.summary_comment",
          leaseEpoch: summaryCoordination.leaseEpoch,
          detail: {
            step: "summary_comment",
            resourceKey: summaryCoordination.resourceKey,
            reviewLens: mode,
            ...(summaryOperationMarker != null ? { operationMarker: summaryOperationMarker } : {}),
          },
          recover: async () => {
            const existing =
              summaryOperationMarker == null
                ? null
                : await findSummaryCommentByOperationMarker(
                    params.prSurface,
                    summaryOperationMarker,
                  );
            if (existing == null) return { kind: "absent" as const };
            return { kind: "reconciled" as const, value: { id: existing.id, updated: false } };
          },
          isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
          mutate: runSummaryUpsert,
        });
  const [summary, currentLabels] = await Promise.all([summaryPromise, labelsPromise]);
  const summaryOnlyCount = params.ledger.accepted.filter(
    (accepted) => accepted.kind === "summary_only",
  ).length;
  await params.recordPublishStep?.("summary_comment", {
    githubId: summary.id,
    meta: {
      inlineCount: params.ledger.postedInlineCount,
      summaryOnlyCount,
      dedupedFindingCount: params.dedupedFindingCount ?? 0,
      diffCacheEmpty: params.cachedDiffIndex == null || params.cachedDiffIndex.files.size === 0,
      updated: summary.updated,
    },
  });
  logDebug("review_published_summary", {
    mode,
    owner,
    repo,
    pr: prNumber,
    commentId: summary.id,
    updated: summary.updated,
  });

  const findingsOutcome = reviewCheckRunOutcome(params.payload.findings);
  const checkOutcome: ReturnType<typeof reviewCheckRunOutcome> =
    coverage.kind === "partial"
      ? { conclusion: "neutral", summary: coverage.note }
      : findingsOutcome;
  const targetUrl = reviewCheckDetailsUrl(owner, repo, prNumber, summary.id);
  if (summaryCoordination) {
    await completeReviewCheckRun(summaryCoordination.pool, {
      prSurface: params.prSurface,
      owner,
      repo,
      prNumber,
      workItemId: summaryCoordination.workItemId,
      resourceKey: summaryCoordination.resourceKey,
      reviewLens: mode,
      leaseEpoch: summaryCoordination.leaseEpoch,
      conclusion: checkOutcome.conclusion,
      summary: checkOutcome.summary,
      detailsUrl: targetUrl,
    });
  }

  if (params.cfg.features.commitStatus) {
    const commitStatus = {
      state:
        coverage.kind === "partial"
          ? ("error" as const)
          : checkOutcome.conclusion === "failure"
            ? ("failure" as const)
            : ("success" as const),
      description: checkOutcome.summary,
      targetUrl,
    };
    try {
      const publishCommitStatus = () =>
        params.prSurface.setReviewCommitStatus(headSha, commitStatus);
      if (summaryCoordination == null) {
        await publishCommitStatus();
      } else {
        await withOperationIntent<void>({
          client: summaryCoordination.pool,
          workItemId: summaryCoordination.workItemId,
          operationKey: reviewCommitStatusOperationKey(summaryCoordination.resourceKey, headSha),
          mutationKind: "github.review_commit_status",
          leaseEpoch: summaryCoordination.leaseEpoch,
          detail: {
            step: "commit_status",
            resourceKey: summaryCoordination.resourceKey,
            headSha,
            context: "pr-agent/review",
            ...commitStatus,
          },
          recover: async () => {
            const current = await params.prSurface.getCiStatus(headSha);
            const found = current.legacyStatuses.some(
              (status) =>
                status.context === "pr-agent/review" &&
                status.state === commitStatus.state &&
                status.description === commitStatus.description &&
                status.targetUrl === (commitStatus.targetUrl ?? null),
            );
            return found
              ? { kind: "reconciled" as const, value: undefined }
              : { kind: "absent" as const };
          },
          isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
          mutate: publishCommitStatus,
        });
      }
    } catch (error) {
      logWarn("review_commit_status_failed", {
        mode,
        owner,
        repo,
        pr: prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (currentLabels instanceof Error) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: currentLabels.message,
    });
    return { kind: "published", summaryCommentId: summary.id };
  }
  if (!Array.isArray(currentLabels)) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: `listPullRequestLabels returned non-array: ${String(currentLabels)}`,
    });
    return { kind: "published", summaryCommentId: summary.id };
  }

  const wantsCategoryLabel = dominantReviewCategory(params.payload.findings) != null;
  const syncCategoryLabels =
    mode === "review" && (wantsCategoryLabel || hasManagedCategoryLabel(currentLabels));
  const syncSizeLabel = params.cfg.features.reviewLabels !== "off";
  const syncSecurityLabel = params.cfg.features.reviewLabels === "size+security";
  if (syncSizeLabel || syncSecurityLabel || syncCategoryLabels) {
    try {
      const options = {
        size: syncSizeLabel,
        security: syncSecurityLabel,
        category: syncCategoryLabels,
      };
      if (labelsAlreadySynced(currentLabels, params.payload, options)) {
        await params.recordPublishStep?.("labels", {
          meta: { labels: currentLabels, alreadySynced: true },
        });
      } else {
        const managed = reviewLabelsFromPayload(params.payload, options);
        const next = syncReviewLabels(currentLabels, managed);
        const publishLabels = () => params.prSurface.setLabels(next);
        if (summaryCoordination == null) {
          await publishLabels();
        } else {
          await withOperationIntent<void>({
            client: summaryCoordination.pool,
            workItemId: summaryCoordination.workItemId,
            operationKey: reviewLabelsOperationKey(summaryCoordination.resourceKey),
            mutationKind: "github.review_labels",
            leaseEpoch: summaryCoordination.leaseEpoch,
            detail: {
              step: "labels",
              resourceKey: summaryCoordination.resourceKey,
              desiredLabels: next,
            },
            recover: async () => {
              const labels = await params.prSurface.getLabels();
              const desired = new Set(next);
              return labels.length === next.length && labels.every((label) => desired.has(label))
                ? { kind: "reconciled" as const, value: undefined }
                : { kind: "absent" as const };
            },
            isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
            mutate: publishLabels,
          });
        }
        await params.recordPublishStep?.("labels", { meta: { labels: next } });
        logDebug("review_labels_synced", { owner, repo, pr: prNumber, labels: next });
      }
    } catch (error) {
      logWarn("review_labels_sync_failed", {
        owner,
        repo,
        pr: prNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { kind: "published", summaryCommentId: summary.id };
}
