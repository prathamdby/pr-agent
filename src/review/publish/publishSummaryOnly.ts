import { decodeProgressComment } from "../../github/prSurfaceResults.js";
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
import {
  closeOutcomeForCoverage,
  reviewVerdict,
  summaryCommentVerdictMeta,
} from "../../agentWork/reviewVerdict.js";
import { logDebug, logWarn } from "../../evlog.js";
import type { PrReviewComment } from "../../github/prSurface.js";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.js";
import { recoverMarkedProgressComment } from "../../github/recoverPrSurfaceMutation.js";
import {
  carriedReaffirmedFindings,
  type AcceptedPlacement,
  type FindingLedger,
  type ReaffirmedFinding,
  type ReviewCoverage,
} from "../orchestrator/orchestratorTypes.js";
import {
  dominantReviewCategory,
  hasManagedCategoryLabel,
  labelsAlreadySynced,
  reviewLabelsFromPayload,
  syncReviewLabels,
} from "../run/reviewLabels.js";
import { renderReviewSummaryComment, type SummaryPlacement } from "../run/reviewRender.js";
import { resolveReviewWallClockMs } from "../run/reviewRunFooter.js";
import { snapshotReviewRunMetrics } from "../run/reviewRunMetrics.js";
import { REVIEW_SUMMARY_SENTINEL, type ReviewPayload } from "../reviewSchema.js";
import { createReviewSummaryComment } from "./reviewSummaryComment.js";
import type { PublishStopReason, ReviewPublishSession } from "./reviewPublishSession.js";
import { errorMessage } from "../../errors/errorMessage.js";
import { snapshotFindingLedger, type RecoveryDecision } from "../recovery/reviewRecovery.js";
import { getOperationIntent } from "../../agentWork/operationIntentRepository.js";
import { reviewArtifactInvalid } from "../recovery/reviewArtifacts.js";
import { createFindingLedger } from "../orchestrator/orchestratorTypes.js";
import { validateReviewPayload } from "../findings/reviewFindingValidator.js";
import { fenceForEpoch } from "../../agentWork/writeFence.js";
import {
  buildFindingView,
  findingCheck,
  type FindingCheck,
} from "../findingIdentity/findingLifecycle.js";

export type PublishSummaryOnlyResult =
  | {
      readonly kind: "published";
      readonly summaryCommentId: number;
      readonly check: FindingCheck;
    }
  | { readonly kind: "stopped"; readonly reason: PublishStopReason };

export async function publishReviewSummaryOnly(
  session: ReviewPublishSession,
  requestedInput: {
    readonly payload: ReviewPayload;
    readonly ledger: FindingLedger;
    readonly coverage?: ReviewCoverage;
    readonly staleReview?: boolean;
    readonly recoveryDecision?: RecoveryDecision;
  },
): Promise<PublishSummaryOnlyResult> {
  const retained = session.recovery?.canReuseSummary()
    ? await session.recovery.load("final-summary")
    : null;
  const saved =
    retained?.artifact.kind === "final_summary" && retained.artifact.inputs?.kind === "summary"
      ? { payload: retained.artifact.payload, inputs: retained.artifact.inputs }
      : undefined;
  const input = saved
    ? {
        ...requestedInput,
        payload: saved.payload,
        ledger: createFindingLedger(saved.inputs.ledger),
        coverage: saved.inputs.coverage,
        staleReview: saved.inputs.staleReview,
      }
    : requestedInput;
  if (saved) {
    const validation = validateReviewPayload({
      payload: input.payload,
      cachedDiffIndex: session.cachedDiffIndex,
      enforceInlineAnchorValidation: false,
    });
    if (!validation.ok) reviewArtifactInvalid("saved_summary_validation");
  }
  const coverage = input.coverage ?? { kind: "full" };
  if (coverage.kind === "none") {
    throw new AppError({
      domain: "review",
      kind: "summary_coverage_none",
      message: "Cannot publish a review summary when every specialist failed",
      context: { failedSpecialists: coverage.failed },
    });
  }
  const duplicates = await session.duplicateCleanup.clean(session);
  const findingView = buildFindingView(session.findingInventory, {
    kind: "reviewed",
    ledger: input.ledger,
    duplicates,
  });
  const check = findingCheck(findingView);
  const startedAt = Date.now();
  const closeOutcome = closeOutcomeForCoverage(coverage, check);
  if (coverage.kind === "partial" && coverage.reason === "unread") {
    logWarn("review_unread_changed_files", {
      count: coverage.paths.length,
      owner: session.ctx.owner,
      repo: session.ctx.repo,
      pr: session.ctx.prNumber,
    });
  }
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
    return { kind: "published", summaryCommentId, check };
  };
  const { owner, repo, prNumber, headSha } = session.ctx;
  const mode = session.mode;
  const summarySentinel = REVIEW_SUMMARY_SENTINEL;
  const summaryPlacements = [
    ...input.ledger.accepted.map(summaryPlacement),
    ...carriedReaffirmedFindings(input.ledger).map(reaffirmedSummaryPlacement),
  ];
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
        message: errorMessage(error),
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
      : await loadRenderableHeadCi(ciPool, owner, repo, headSha, session.installationId);
  const ciSummary = renderedCi.summary;
  const durationMs = resolveReviewWallClockMs({
    metricsStartedAtMs: metricsSnapshot?.startedAtMs,
    endedAtMs: Date.now(),
  });
  const summaryBody = renderReviewSummaryComment(input.payload, {
    ...session.ctx,
    summarySentinel,
    placements: enrichedPlacements,
    findingView,
    mode,
    staleReview: input.staleReview ?? false,
    cachedDiffIndex: session.cachedDiffIndex,
    ciSummary,
    ciVersion: renderedCi.version,
    coverage:
      coverage.kind === "partial" && coverage.reason === "unread"
        ? { kind: "partial", failed: [], unread: true }
        : coverage.kind === "full"
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

  const labelsAvailable =
    (session.prSurface.capabilities?.access("labelsRead") ?? "available") === "available" &&
    (session.prSurface.capabilities?.access("labelsWrite") ?? "available") === "available";
  const labelsPromise = labelsAvailable
    ? session.prSurface.getLabels().catch((error: unknown) => error)
    : Promise.resolve(null);
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
  const inputs = saved?.inputs ?? {
    kind: "summary" as const,
    ledger: snapshotFindingLedger(input.ledger),
    coverage:
      coverage.kind === "full"
        ? coverage
        : coverage.reason === "unread"
          ? {
              kind: "partial" as const,
              reason: "unread" as const,
              paths: [...coverage.paths],
              note: coverage.note,
            }
          : {
              kind: "partial" as const,
              reason: "specialists" as const,
              failed: [...coverage.failed],
              note: coverage.note,
            },
    staleReview: input.staleReview ?? false,
    judgmentDegraded: session.recovery?.getJudgmentDegraded() ?? false,
    briefFallback: session.recovery?.getBriefFallback() ?? false,
  };
  await session.recovery?.saveSummary(input.payload, inputs);
  const recoveryDecision =
    input.recoveryDecision ??
    (await session.recovery?.prepare(
      input.payload,
      summaryOperationKey ?? `summary:${owner}/${repo}#${prNumber}`,
      inputs,
    )) ??
    null;
  if (input.recoveryDecision?.settled && summaryCoordination) {
    const intent = await getOperationIntent(
      summaryCoordination.pool,
      summaryCoordination.workItemId,
      summaryOperationKey ?? reviewSummaryOperationKey(summaryCoordination.resourceKey, mode),
    );
    if (!intent) reviewArtifactInvalid("settled_summary_receipt_missing");
  }
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
          decodeResult: decodeProgressComment,
          fence: fenceForEpoch(summaryCoordination.leaseEpoch),
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
      diffCacheEmpty: session.cachedDiffIndex == null || session.cachedDiffIndex.files.size === 0,
      updated: summary.updated,
      ...summaryCommentVerdictMeta({
        kind: closeOutcome.kind === "partial" ? "partial" : "published",
        note: closeOutcome.kind === "partial" ? closeOutcome.note : undefined,
        conclusion: check.conclusion,
        partialReason: coverage.kind === "partial" ? coverage.reason : undefined,
      }),
    },
  });
  await session.recovery?.settle(recoveryDecision, summary.id);
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
      closeOutcome.kind === "not_published" ? { kind: "published", ...check } : closeOutcome,
    );
  }

  if (!labelsAvailable) return finishPublished(summary.id);
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
            fence: fenceForEpoch(summaryCoordination.leaseEpoch),
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
        message: errorMessage(error),
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

function summaryPlacement(accepted: AcceptedPlacement): SummaryPlacement {
  if (accepted.kind !== "summary_only") return accepted.placement;
  const { finding } = accepted.placement;
  return {
    ...accepted.placement,
    findingRow: {
      id: accepted.findingId,
      lens: accepted.source,
      severity: finding.severity,
      path: finding.file,
      line: finding.startLine,
      title: finding.title,
      ...(accepted.reopens != null ? { reopens: accepted.reopens } : {}),
    },
  };
}

function reaffirmedSummaryPlacement(entry: ReaffirmedFinding): SummaryPlacement {
  if (entry.heldBy !== "summary") return entry.placement;
  const { finding } = entry.placement;
  return {
    ...entry.placement,
    findingRow: {
      id: entry.id,
      lens: entry.source,
      severity: entry.severity,
      path: finding.file,
      line: finding.startLine,
      title: finding.title,
    },
  };
}

function enrichPlacementsWithInlineCommentUrls(
  placements: readonly SummaryPlacement[],
  comments: readonly PublishedReviewComment[],
): SummaryPlacement[] {
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
