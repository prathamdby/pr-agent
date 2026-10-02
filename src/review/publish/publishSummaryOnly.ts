import { emitWorkSpan } from "../../agent/runtime/agentEventSink.js";
import { publishSpanFromContext } from "../../analytics/workSpan.js";
import { AppError } from "../../errors/appError.js";
import {
  operationIntentMarker,
  reviewLabelsOperationKey,
  reviewSummaryOperationKey,
  publishOnce,
} from "../../agentWork/publishOnce.js";
import { loadRenderableHeadCi, requestHeadCiProjection } from "../../agentWork/ciProjection.js";
import { reviewVerdict, summaryCommentVerdictMeta } from "../../agentWork/reviewVerdict.js";
import { logDebug, logWarn } from "../../evlog.js";
import type { PrReviewComment } from "../../github/prSurface.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import { recoverMarkedProgressComment } from "../../github/recoverPrSurfaceMutation.js";
import type { FindingLedger, ReviewCoverage } from "../orchestrator/orchestratorTypes.js";
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
import { REVIEW_SUMMARY_SENTINEL, type ReviewPayload } from "../reviewSchema.js";
import { createReviewSummaryComment } from "./reviewSummaryComment.js";
import type { PublishStopReason, ReviewPublishSession } from "./reviewPublishSession.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";

export type PublishSummaryOnlyResult =
  | { readonly kind: "published"; readonly summaryCommentId: number }
  | { readonly kind: "stopped"; readonly reason: PublishStopReason };

export async function publishReviewSummaryOnly(
  session: ReviewPublishSession,
  input: {
    readonly payload: ReviewPayload;
    readonly ledger: FindingLedger;
    readonly coverage?: ReviewCoverage;
    readonly staleReview?: boolean;
    readonly dedupedFindingCount?: number;
  },
): Promise<PublishSummaryOnlyResult> {
  const coverage = input.coverage ?? { kind: "full" };
  if (coverage.kind === "none") {
    throw new AppError({
      code: "review.summary_coverage_none",
      message: "Cannot publish a review summary when every specialist failed",
      context: { failedSpecialists: coverage.failed },
    });
  }
  const startedAt = Date.now();
  const finishPublished = (summaryCommentId: number): PublishSummaryOnlyResult => {
    if (session.agentEvents) {
      emitWorkSpan(
        session.agentEvents,
        session.cfg,
        publishSpanFromContext({
          context: session.agentEvents,
          publishStep: "summary",
          latencyMs: Date.now() - startedAt,
          isError: false,
        }),
      );
    }
    return { kind: "published", summaryCommentId };
  };
  const { owner, repo, prNumber, headSha } = session.ctx;
  const mode = session.mode;
  const summarySentinel = REVIEW_SUMMARY_SENTINEL;
  const summaryPlacements = input.ledger.accepted.map((accepted) => accepted.placement);
  // Prefer URLs already attached during inline publish; fetch the PR once for the rest.
  const placementsNeedingUrls = summaryPlacements.some(
    (placement) => placement.inlinePosted && placement.inlineCommentUrl == null,
  );
  let reviewComments: readonly PublishedReviewComment[] = [];
  if (placementsNeedingUrls) {
    try {
      const listed = await session.prSurface.listReviewComments();
      reviewComments = publishedReviewComments(listed.comments);
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
  const summaryCoordination = session.recordPublishStep?.summaryCommentCoordination;
  const ciPool = session.pool ?? summaryCoordination?.pool;
  const renderedCi =
    ciPool == null
      ? { summary: undefined, version: 0 }
      : await loadRenderableHeadCi(ciPool, owner, repo, headSha);
  const ciSummary = renderedCi.summary;
  const durationMs = resolveReviewWallClockMs({
    metricsStartedAtMs: metricsSnapshot?.startedAtMs,
    endedAtMs: Date.now(),
  });
  const summaryBody = renderReviewSummaryComment(input.payload, {
    ...session.ctx,
    summarySentinel,
    placements: enrichedPlacements,
    mode,
    staleReview: input.staleReview ?? false,
    cachedDiffIndex: session.cachedDiffIndex,
    ciSummary,
    ciVersion: renderedCi.version,
    coverage:
      coverage.kind === "full"
        ? { kind: "full", failed: [] }
        : { kind: coverage.kind, failed: coverage.failed },
    runFooter: {
      durationMs,
      model: session.cfg.models.model,
    },
  });

  const stopReason = await session.stopReason();
  if (stopReason != null) return { kind: "stopped", reason: stopReason };

  let knownSummaryCommentRef: { id: number; url: string } | null = null;
  if (session.shouldLinkToSummary) {
    const resolvedSummary = await session.prSurface.resolveProgressComment(
      summarySentinel,
      session.progressCommentIdHint,
    );
    knownSummaryCommentRef = resolvedSummary
      ? { id: resolvedSummary.id, url: resolvedSummary.url }
      : null;
  }

  const labelsPromise = session.prSurface.getLabels().catch((error: unknown) => error);
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
    createReviewSummaryComment({
      prSurface: session.prSurface,
      reviewLens: mode,
      coordination: summaryCoordination,
    }).conclude({
      body: summaryBodyForPublish,
      hintCommentId: session.progressCommentIdHint ?? knownSummaryCommentRef?.id,
      knownExisting: knownSummaryCommentRef,
    });
  const summaryPromise =
    summaryCoordination == null
      ? runSummaryUpsert()
      : publishOnce<{ readonly id: number; readonly updated: boolean }>({
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
          recover: () =>
            recoverMarkedProgressComment(session.prSurface, {
              operationMarker: summaryOperationMarker ?? undefined,
              sentinel: summarySentinel,
              knownExistingId: knownSummaryCommentRef?.id,
            }),
          isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
          mutate: runSummaryUpsert,
        });
  const [summary, currentLabels] = await Promise.all([summaryPromise, labelsPromise]);
  if (ciPool != null) {
    await requestHeadCiProjection(
      session.boss,
      { installationId: session.installationId ?? 0, owner, repo, headSha },
      { kind: "when_due", pool: ciPool, renderedVersion: renderedCi.version },
    );
  }
  const summaryOnlyCount = input.ledger.accepted.filter(
    (accepted) => accepted.kind === "summary_only",
  ).length;
  await session.recordPublishStep?.("summary_comment", {
    githubId: summary.id,
    meta: {
      inlineCount: input.ledger.postedInlineCount,
      summaryOnlyCount,
      dedupedFindingCount: input.dedupedFindingCount ?? 0,
      diffCacheEmpty: session.cachedDiffIndex == null || session.cachedDiffIndex.files.size === 0,
      updated: summary.updated,
      ...summaryCommentVerdictMeta({
        kind: coverage.kind === "partial" ? "partial" : "published",
        note: coverage.kind === "partial" ? coverage.note : undefined,
        findings: input.payload.findings,
      }),
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

  if (session.verdict != null) {
    await reviewVerdict({
      pool: session.verdict.pool,
      prSurface: session.prSurface,
      owner,
      repo,
      prNumber,
      workItemId: session.verdict.workItemId,
      resourceKey: session.verdict.resourceKey,
      reviewLens: mode,
      headSha,
      leaseEpoch: session.verdict.leaseEpoch,
      commitStatusEnabled: session.cfg.features.commitStatus,
      summaryCommentId: summary.id,
    }).close(
      coverage.kind === "partial"
        ? { kind: "partial", note: coverage.note }
        : { kind: "published", findings: input.payload.findings },
    );
  }

  if (currentLabels instanceof Error) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: currentLabels.message,
    });
    return finishPublished(summary.id);
  }
  if (!Array.isArray(currentLabels)) {
    logWarn("review_labels_fetch_failed", {
      mode,
      owner,
      repo,
      pr: prNumber,
      message: `listPullRequestLabels returned non-array: ${String(currentLabels)}`,
    });
    return finishPublished(summary.id);
  }

  const wantsCategoryLabel = dominantReviewCategory(input.payload.findings) != null;
  const syncCategoryLabels =
    mode === "review" && (wantsCategoryLabel || hasManagedCategoryLabel(currentLabels));
  const syncSizeLabel = session.cfg.features.reviewLabels !== "off";
  const syncSecurityLabel = session.cfg.features.reviewLabels === "size+security";
  if (syncSizeLabel || syncSecurityLabel || syncCategoryLabels) {
    try {
      const options = {
        size: syncSizeLabel,
        security: syncSecurityLabel,
        category: syncCategoryLabels,
      };
      if (labelsAlreadySynced(currentLabels, input.payload, options)) {
        await session.recordPublishStep?.("labels", {
          meta: { labels: currentLabels, alreadySynced: true },
        });
      } else {
        const managed = reviewLabelsFromPayload(input.payload, options);
        const next = syncReviewLabels(currentLabels, managed);
        const publishLabels = () => session.prSurface.setLabels(next);
        if (summaryCoordination == null) {
          await publishLabels();
        } else {
          await publishOnce<void>({
            client: summaryCoordination.pool,
            workItemId: summaryCoordination.workItemId,
            operationKey: reviewLabelsOperationKey(summaryCoordination.resourceKey),
            mutationKind: "github.review_labels",
            leaseEpoch: summaryCoordination.leaseEpoch,
            allowsUndefinedResult: true,
            detail: {
              step: "labels",
              resourceKey: summaryCoordination.resourceKey,
              desiredLabels: next,
            },
            recover: async () => {
              const labels = await session.prSurface.getLabels();
              const desired = new Set(next);
              return labels.length === next.length && labels.every((label) => desired.has(label))
                ? { kind: "reconciled" as const, value: undefined }
                : { kind: "absent" as const };
            },
            isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
            mutate: publishLabels,
          });
        }
        await session.recordPublishStep?.("labels", { meta: { labels: next } });
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

  return finishPublished(summary.id);
}

type PublishedReviewComment = {
  readonly path: string;
  readonly line: number;
  readonly id: number;
  readonly url: string;
};

function publishedReviewComments(
  comments: readonly Pick<PrReviewComment, "path" | "line" | "id" | "htmlUrl">[],
): PublishedReviewComment[] {
  return comments
    .flatMap((comment) =>
      comment.path == null || comment.line == null
        ? []
        : [{ path: comment.path, line: comment.line, id: comment.id, url: comment.htmlUrl }],
    )
    .toSorted((a, b) => a.id - b.id);
}

function reviewCommentAnchorKey(path: string, line: number): string {
  return `${path}:${line}`;
}

/** Match GitHub review comments to inline placements in placement order (FIFO per anchor). */
function enrichPlacementsWithInlineCommentUrls(
  placements: readonly InlinePlacement[],
  comments: readonly PublishedReviewComment[],
): InlinePlacement[] {
  const commentsByAnchor = new Map<string, PublishedReviewComment[]>();
  for (const comment of comments) {
    const key = reviewCommentAnchorKey(comment.path, comment.line);
    const bucket = commentsByAnchor.get(key) ?? [];
    bucket.push(comment);
    commentsByAnchor.set(key, bucket);
  }

  const anchorUseIndex = new Map<string, number>();

  return placements.map((placement) => {
    if (!placement.inlinePosted || placement.inlineLine == null) return placement;
    const key = reviewCommentAnchorKey(placement.finding.file, placement.inlineLine);
    const bucket = commentsByAnchor.get(key);
    if (!bucket || bucket.length === 0) return placement;
    const index = anchorUseIndex.get(key) ?? 0;
    const comment = bucket[index];
    if (!comment) return placement;
    anchorUseIndex.set(key, index + 1);
    return { ...placement, inlineCommentUrl: comment.url };
  });
}
