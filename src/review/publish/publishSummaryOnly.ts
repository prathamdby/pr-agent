import type { Config } from "../../config.js";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../../errors/appError.js";
import {
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
import {
  findIssueCommentBySentinel,
  listPullRequestLabels,
  listPullRequestReviewComments,
  resolveVerifiedSummaryCommentRef,
  setPullRequestLabels,
  setReviewCommitStatus,
  upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
import {
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_WAIT_MS,
  REVIEW_CI_SUMMARY_WAIT_POLL_MS,
  REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
} from "../../settings/index.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { buildCiSummary } from "../ci/analyzeCi.js";
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
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  sentinel: string,
  hintCommentId: number | null | undefined,
  expiresAtTs?: number,
): Promise<{ id: number; url: string } | null> {
  const resolved = await resolveVerifiedSummaryCommentRef(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    hintCommentId,
    expiresAtTs,
  );
  return resolved ? { id: resolved.id, url: resolved.url } : null;
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
  resourceKey: string;
  reviewLens: AnyReviewLens;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  sentinel: string;
  expiresAtTs?: number;
  hintCommentId?: number | null;
  progressRevision?: ProgressCommentRevision;
};

async function upsertSummaryCommentWithoutRevision(
  params: SummaryCommentUpsertParams,
): Promise<SummaryCommentUpsertResult> {
  const {
    pool,
    workItemId,
    resourceKey,
    reviewLens,
    token,
    owner,
    repo,
    prNumber,
    body,
    sentinel,
    expiresAtTs,
  } = params;

  const storedId = await getSummaryCommentGithubId(pool, resourceKey, reviewLens);
  const hintId = params.hintCommentId ?? storedId ?? null;
  const knownFromStored = await resolveKnownSummaryCommentRef(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    hintId,
    expiresAtTs,
  );
  if (knownFromStored) {
    return upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      body,
      sentinel,
      knownFromStored,
      expiresAtTs,
    );
  }

  if (workItemId == null) {
    const scanned = await findIssueCommentBySentinel(
      token,
      owner,
      repo,
      prNumber,
      sentinel,
      expiresAtTs,
    );
    return upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      body,
      sentinel,
      scanned,
      expiresAtTs,
    );
  }

  const claimWon = await claimSummaryCommentCreation(pool, workItemId, resourceKey, reviewLens);
  if (claimWon) {
    const scanned = await findIssueCommentBySentinel(
      token,
      owner,
      repo,
      prNumber,
      sentinel,
      expiresAtTs,
    );
    return upsertReviewSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      body,
      sentinel,
      scanned,
      expiresAtTs,
    );
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
    const knownFromPoll = await resolveKnownSummaryCommentRef(
      token,
      owner,
      repo,
      prNumber,
      sentinel,
      polledId,
      expiresAtTs,
    );
    if (knownFromPoll) {
      return upsertReviewSummaryComment(
        token,
        owner,
        repo,
        prNumber,
        body,
        sentinel,
        knownFromPoll,
        expiresAtTs,
      );
    }
  }

  const scanned = await findIssueCommentBySentinel(
    token,
    owner,
    repo,
    prNumber,
    sentinel,
    expiresAtTs,
  );
  return upsertReviewSummaryComment(
    token,
    owner,
    repo,
    prNumber,
    body,
    sentinel,
    scanned,
    expiresAtTs,
  );
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
    findIssueCommentBySentinel(
      params.token,
      params.owner,
      params.repo,
      params.prNumber,
      params.sentinel,
      params.expiresAtTs,
    ),
  ]);
  const bodyRevision = currentComment ? parseProgressRevisionState(currentComment.body) : null;
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
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly refreshLiveAuth?: () => Promise<void>;
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
  let reviewComments: Awaited<ReturnType<typeof listPullRequestReviewComments>>["comments"] = [];
  if (placementsNeedingUrls) {
    try {
      const token = params.getToken();
      const tokenExpiresAtTs = params.getTokenExpiresAtTs?.();
      const listed = await listPullRequestReviewComments(
        token,
        owner,
        repo,
        prNumber,
        tokenExpiresAtTs,
      );
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
  const ciToken = params.getToken();
  const ciTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
  const ciSummary = await buildCiSummary({
    token: ciToken,
    owner,
    repo,
    headSha,
    expiresAtTs: ciTokenExpiresAtTs,
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

  await params.refreshLiveAuth?.();
  const summaryToken = params.getToken();
  const summaryTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
  let knownSummaryCommentRef: { id: number; url: string } | null = null;
  if (params.shouldLinkToSummary) {
    const resolvedSummary = await resolveVerifiedSummaryCommentRef(
      summaryToken,
      owner,
      repo,
      prNumber,
      summarySentinel,
      params.progressCommentIdHint,
      summaryTokenExpiresAtTs,
    );
    knownSummaryCommentRef = resolvedSummary
      ? { id: resolvedSummary.id, url: resolvedSummary.url }
      : null;
  }

  await params.refreshLiveAuth?.();
  const labelsToken = params.getToken();
  const labelsTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
  const labelsPromise = listPullRequestLabels(
    labelsToken,
    owner,
    repo,
    prNumber,
    labelsTokenExpiresAtTs,
  ).catch((error: unknown) => error);
  const runSummaryUpsert = () =>
    summaryCoordination
      ? upsertSummaryCommentWithCreationClaim({
          ...summaryCoordination,
          reviewLens: mode,
          token: summaryToken,
          owner,
          repo,
          prNumber,
          body: summaryBody,
          sentinel: summarySentinel,
          expiresAtTs: summaryTokenExpiresAtTs,
          hintCommentId: params.progressCommentIdHint ?? knownSummaryCommentRef?.id,
          progressRevision: 7,
        })
      : upsertReviewSummaryComment(
          summaryToken,
          owner,
          repo,
          prNumber,
          summaryBody,
          summarySentinel,
          knownSummaryCommentRef,
          summaryTokenExpiresAtTs,
        );
  const summaryPromise =
    summaryCoordination == null
      ? runSummaryUpsert()
      : withOperationIntent({
          client: summaryCoordination.pool,
          workItemId: summaryCoordination.workItemId,
          operationKey: reviewSummaryOperationKey(summaryCoordination.resourceKey, mode),
          mutationKind: "github.summary_comment",
          detail: {
            step: "summary_comment",
            resourceKey: summaryCoordination.resourceKey,
            reviewLens: mode,
          },
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
    await params.refreshLiveAuth?.();
    const checkToken = params.getToken();
    const checkTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
    await completeReviewCheckRun(summaryCoordination.pool, {
      token: checkToken,
      tokenExpiresAtTs: checkTokenExpiresAtTs,
      owner,
      repo,
      prNumber,
      workItemId: summaryCoordination.workItemId,
      resourceKey: summaryCoordination.resourceKey,
      reviewLens: mode,
      conclusion: checkOutcome.conclusion,
      summary: checkOutcome.summary,
      detailsUrl: targetUrl,
    });
  }

  if (params.cfg.features.commitStatus) {
    try {
      await params.refreshLiveAuth?.();
      const commitStatusToken = params.getToken();
      const commitStatusTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
      await setReviewCommitStatus(
        commitStatusToken,
        owner,
        repo,
        headSha,
        {
          state:
            coverage.kind === "partial"
              ? "error"
              : checkOutcome.conclusion === "failure"
                ? "failure"
                : "success",
          description: checkOutcome.summary,
          targetUrl,
        },
        commitStatusTokenExpiresAtTs,
      );
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
  const syncEffortLabel = params.cfg.features.reviewLabels !== "off";
  const syncSecurityLabel = params.cfg.features.reviewLabels === "effort+security";
  if (syncEffortLabel || syncSecurityLabel || syncCategoryLabels) {
    try {
      const options = {
        effort: syncEffortLabel,
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
        await params.refreshLiveAuth?.();
        const labelsWriteToken = params.getToken();
        const labelsWriteTokenExpiresAtTs = params.getTokenExpiresAtTs?.();
        await setPullRequestLabels(
          labelsWriteToken,
          owner,
          repo,
          prNumber,
          next,
          labelsWriteTokenExpiresAtTs,
        );
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
