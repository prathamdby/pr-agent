import crypto from "node:crypto";
import {
  type FingerprintedInlinePlacement,
  reviewFindingPlacementKey,
} from "../placement/reviewDiffPlacement.js";
import { publishInlineReviewComments } from "../placement/reviewInlinePublish.js";
import {
  renderInlineThreadBody,
  renderReviewPointerLensMarker,
  renderSpecialistReviewBody,
} from "../run/reviewRender.js";
import { AppError } from "../../errors/appError.js";
import { fingerprintCandidates } from "../findings/reviewFindingFingerprint.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../findings/findingPipeline.js";
import type { ReviewFinding } from "../reviewSchema.js";
import { reviewPayloadFromFindings } from "../reviewSchema.js";
import type { RepoPolicyResult } from "../repoPolicy.js";
import { resolveBoundPolicyFooters, type BoundPolicyJudge } from "./boundPolicyJudge.js";
import type { PublishStopReason, ReviewPublishSession } from "./reviewPublishSession.js";
import {
  deterministicInlineBatchId,
  operationIntentMarker,
  reviewInlineBatchOperationKey,
  publishOnce,
} from "../../agentWork/publishOnce.js";
import { safeEmitPublishEvent } from "../../agent/runtime/agentEventSink.js";
import type {
  AcceptedPlacement,
  FindingLedger,
  FindingLedgerDelta,
  FindingSource,
} from "../orchestrator/orchestratorTypes.js";
import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.js";
import type { EvidenceLedger } from "../findings/evidenceLedger.js";
import { safeUpsertFindingHistoryOpen } from "../../agentWork/findingHistoryRepository.js";
import { isDefinitelyNoAcceptanceReviewError } from "../../github/reviewErrors.js";
import { findPublishedThreadBatch } from "../../github/prSurfaceHelpers.js";

type StoredInlineBatch = {
  readonly version: 2;
  readonly batchId: string;
  readonly workItemId: string;
  readonly specialist: FindingSource;
  readonly headSha: string;
  readonly reviewId: number;
  readonly reviewUrl: string;
  readonly event: "COMMENT";
  readonly fingerprints: readonly string[];
  readonly placements: readonly {
    readonly finding: ReviewFinding;
    readonly resolvedLine: number;
    readonly canonicalFingerprint: string;
  }[];
  readonly counts: {
    readonly posted: number;
    readonly suppressed: number;
    readonly capDowngraded: number;
    readonly anchorDropped: number;
  };
};

export type FindingBatchResult =
  | { readonly kind: "published"; readonly delta: FindingLedgerDelta; readonly reviewId: number }
  | { readonly kind: "empty"; readonly delta: FindingLedgerDelta }
  | { readonly kind: "budget_exhausted"; readonly delta: FindingLedgerDelta }
  | { readonly kind: "stopped"; readonly reason: PublishStopReason };

/** Per-call inputs; shared run identity and the abort policy live on the session. */
export type FindingBatchInput = {
  readonly source: FindingSource;
  readonly ledger: FindingLedger;
  readonly evidenceLedger?: EvidenceLedger;
  readonly checkoutCoverage?: CheckoutCoverage;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly repoPolicy?: RepoPolicyResult;
  readonly sameRepo?: boolean;
  readonly boundPolicyJudge?: BoundPolicyJudge;
  readonly readCheckoutFile?: (path: string) => Promise<string | undefined>;
  readonly crossPrSuppressionFingerprints?: readonly string[];
};

function emptyDelta(overrides?: Partial<FindingLedgerDelta>): FindingLedgerDelta {
  return {
    accepted: [],
    suppressionFingerprints: [],
    inlineReviewIds: [],
    postedInlineCount: 0,
    threadCallCount: 1,
    threadBudgetExhausted: false,
    ...overrides,
  };
}

function hasAcceptedFingerprint(
  placement: FingerprintedInlinePlacement,
  ledger: FindingLedger,
): boolean {
  const candidates = new Set(fingerprintCandidates(placement.finding));
  return ledger.accepted.some((accepted) => candidates.has(accepted.canonicalFingerprint));
}

function summaryOnlyPlacement(
  placement: FingerprintedInlinePlacement,
  source: FindingSource,
  reason: Extract<AcceptedPlacement, { kind: "summary_only" }>["reason"],
): AcceptedPlacement {
  return {
    kind: "summary_only",
    source,
    placement: { ...placement, inlinePosted: false },
    canonicalFingerprint: placement.inlineFingerprint,
    reason,
  };
}

function acceptedSummaryPlacements(params: {
  readonly targets: readonly FingerprintedInlinePlacement[];
  readonly planned: readonly FingerprintedInlinePlacement[];
  readonly source: FindingSource;
  readonly ledger: FindingLedger;
  readonly budgetExhausted?: boolean;
}): AcceptedPlacement[] {
  const plannedByKey = new Map(
    params.planned.map((placement) => [reviewFindingPlacementKey(placement.finding), placement]),
  );
  return params.targets.flatMap((placement) => {
    if (
      fingerprintCandidates(placement.finding).some((candidate) =>
        params.ledger.suppressionFingerprints.has(candidate),
      )
    ) {
      if (hasAcceptedFingerprint(placement, params.ledger)) return [];
      return [summaryOnlyPlacement(placement, params.source, "historical")];
    }
    if (placement.inlinePosted && !params.budgetExhausted) return [];
    const planned = plannedByKey.get(reviewFindingPlacementKey(placement.finding));
    const reason = params.budgetExhausted ? "budget" : planned?.inlinePosted ? "cap" : "anchor";
    return [summaryOnlyPlacement(placement, params.source, reason)];
  });
}

function acceptedFingerprints(accepted: readonly AcceptedPlacement[]): string[] {
  return [...new Set(accepted.map((placement) => placement.canonicalFingerprint))];
}

function storedPlacement(
  placement: FingerprintedInlinePlacement,
): StoredInlineBatch["placements"][number] {
  if (placement.inlineLine == null) {
    throw new AppError({
      code: "review.posted_placement_missing_line",
      message: "Posted inline placement is missing its resolved line",
    });
  }
  return {
    finding: placement.finding,
    resolvedLine: placement.inlineLine,
    canonicalFingerprint: placement.inlineFingerprint,
  };
}

export async function publishFindingBatch(
  batch: readonly ReviewFinding[],
  session: ReviewPublishSession,
  input: FindingBatchInput,
): Promise<FindingBatchResult> {
  const prepared = prepareReviewPayloadForPublish({
    payload: reviewPayloadFromFindings(batch),
    cachedDiffIndex: session.cachedDiffIndex,
    enforceInlineAnchorValidation: false,
    evidenceLedger: input.evidenceLedger,
    headSha: session.ctx.headSha,
    checkoutCoverage: input.checkoutCoverage,
    isPathInCheckout: input.isPathInCheckout,
  });
  if (!prepared.ok) {
    throw new AppError({
      code: "review.finding_batch_invalid",
      message: prepared.error,
    });
  }

  const remainingInline = Math.max(
    0,
    session.cfg.review.maxInlineComments - input.ledger.postedInlineCount,
  );
  const targets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    cachedDiffIndex: session.cachedDiffIndex,
    inlinePlacements: prepared.prepared.placements,
    storedInlineFingerprints: [...input.ledger.suppressionFingerprints],
    crossPrSuppressionFingerprints: input.crossPrSuppressionFingerprints,
    maxInlineComments: remainingInline,
  });

  if (
    input.ledger.threadBudgetExhausted ||
    input.ledger.threadCallCount >= session.cfg.review.maxThreadPublishCalls
  ) {
    const accepted = acceptedSummaryPlacements({
      targets: targets.placements,
      planned: targets.planned,
      source: input.source,
      ledger: input.ledger,
      budgetExhausted: true,
    });
    return {
      kind: "budget_exhausted",
      delta: emptyDelta({
        accepted,
        suppressionFingerprints: acceptedFingerprints(accepted),
        threadBudgetExhausted: true,
      }),
    };
  }

  const acceptedBeforePublish = acceptedSummaryPlacements({
    targets: targets.placements,
    planned: targets.planned,
    source: input.source,
    ledger: input.ledger,
  });
  if (targets.inline.length === 0) {
    return {
      kind: "empty",
      delta: emptyDelta({
        accepted: acceptedBeforePublish,
        suppressionFingerprints: acceptedFingerprints(acceptedBeforePublish),
      }),
    };
  }

  if (session.recordPublishStep && session.workItemId == null) {
    throw new AppError({
      code: "review.work_item_id_required",
      message: "workItemId is required when recording an inline review batch",
    });
  }

  const stopReason = await session.stopReason();
  if (stopReason != null) return { kind: "stopped", reason: stopReason };

  const progressCommentUrl = (await session.resolveProgressCommentUrl())?.trim();
  if (!progressCommentUrl) {
    throw new AppError({
      code: "review.progress_comment_url_required",
      message:
        "Progress comment URL is required before publishing a specialist review batch; the progress stub must exist first",
    });
  }

  const findingFingerprints = targets.inline.map((placement) => placement.inlineFingerprint);
  const intentWorkItemId = session.operationIntent?.workItemId ?? session.workItemId;
  const batchId =
    intentWorkItemId != null
      ? deterministicInlineBatchId({
          workItemId: intentWorkItemId,
          specialist: input.source,
          findingFingerprints,
        })
      : crypto.randomUUID();
  const operationKey = reviewInlineBatchOperationKey(batchId);
  const operationMarker =
    intentWorkItemId == null ? null : operationIntentMarker(operationKey, intentWorkItemId);
  const boundByKey = await resolveBoundPolicyFooters({
    policy: input.repoPolicy ?? { kind: "absent" },
    sameRepo: input.sameRepo,
    findings: targets.inline.map((placement) => placement.finding),
    judge: input.boundPolicyJudge,
    evidenceLedger: input.evidenceLedger,
    isPathInCheckout: input.isPathInCheckout,
    readCheckoutFile: input.readCheckoutFile,
  });
  const publishInline = () =>
    publishInlineReviewComments({
      prSurface: session.prSurface,
      renderReviewBody: () =>
        `${renderSpecialistReviewBody({
          specialist: input.source,
          progressCommentUrl,
          lensMarker: renderReviewPointerLensMarker("review"),
        })}${operationMarker == null ? "" : `\n${operationMarker}`}`,
      event: "COMMENT",
      commitId: session.ctx.headSha,
      inlinePlacements: targets.inline,
      renderCommentBody: (finding) =>
        renderInlineThreadBody(
          finding,
          session.ctx,
          boundByKey.get(reviewFindingPlacementKey(finding)) ?? [],
        ),
    });
  const publishStartedAt = Date.now();
  const inlineResult = await (session.operationIntent == null
    ? publishInline()
    : publishOnce<
        Awaited<ReturnType<typeof publishInlineReviewComments<FingerprintedInlinePlacement>>>
      >({
        client: session.operationIntent.client,
        workItemId: session.operationIntent.workItemId,
        operationKey,
        mutationKind: "github.inline_review",
        leaseEpoch: session.operationIntent.leaseEpoch,
        detail: {
          step: "inline_review",
          resourceKey: session.operationIntent.resourceKey,
          reviewLens: input.source,
          batchId,
          operationMarker,
        },
        recover: async () => {
          if (operationMarker == null) return { kind: "absent" as const };
          const found = await findPublishedThreadBatch(
            session.prSurface,
            operationMarker,
            session.ctx.headSha,
          );
          return found == null
            ? { kind: "absent" as const }
            : {
                kind: "reconciled" as const,
                value: {
                  review: { id: found.reviewId, url: found.reviewUrl },
                  postedPlacements: [...targets.inline],
                  anchorDroppedPlacements: [],
                  lineResolutionFallback: false,
                },
              };
        },
        isKnownNoAcceptanceError: isDefinitelyNoAcceptanceReviewError,
        mutate: publishInline,
      }));
  const publishLatencyMs = Math.max(0, Date.now() - publishStartedAt);

  const posted = inlineResult.postedPlacements;
  const anchorDropped = inlineResult.anchorDroppedPlacements.map((placement) =>
    summaryOnlyPlacement(placement, input.source, "anchor"),
  );
  const acceptedWithoutPosted = [...acceptedBeforePublish, ...anchorDropped];
  const review = inlineResult.review;
  if (!review) {
    return {
      kind: "empty",
      delta: emptyDelta({
        accepted: acceptedWithoutPosted,
        suppressionFingerprints: acceptedFingerprints(acceptedWithoutPosted),
      }),
    };
  }

  const postedAccepted: AcceptedPlacement[] = posted.map((placement) => ({
    kind: "posted",
    source: input.source,
    placement,
    canonicalFingerprint: placement.inlineFingerprint,
    reviewId: review.id,
  }));
  const accepted = [...acceptedWithoutPosted, ...postedAccepted];
  const batchRecord: StoredInlineBatch | undefined = session.workItemId
    ? {
        version: 2,
        batchId,
        workItemId: session.workItemId,
        specialist: input.source,
        headSha: session.ctx.headSha,
        reviewId: review.id,
        reviewUrl: review.url,
        event: "COMMENT",
        fingerprints: posted.map((placement) => placement.inlineFingerprint),
        placements: posted.map(storedPlacement),
        counts: {
          posted: posted.length,
          suppressed: targets.dropped.suppressedInlineCount,
          capDowngraded: targets.dropped.inlineCommentCapExcluded,
          anchorDropped: inlineResult.anchorDroppedPlacements.length,
        },
      }
    : undefined;
  if (session.recordPublishStep && batchRecord) {
    await session.recordPublishStep("inline_review", {
      githubId: review.id,
      meta: batchRecord,
    });
  }

  if (session.agentEvents) {
    safeEmitPublishEvent(session.agentEvents, session.cfg, {
      specialist: input.source,
      batchId,
      postedCount: posted.length,
      suppressedCount: targets.dropped.suppressedInlineCount,
      capDowngraded: targets.dropped.inlineCommentCapExcluded,
      anchorDropped: inlineResult.anchorDroppedPlacements.length,
      latencyMs: publishLatencyMs,
    });
  }

  if (session.pool && session.installationId != null) {
    const postedFingerprints = posted.map((placement) => placement.inlineFingerprint);
    safeUpsertFindingHistoryOpen(
      session.pool,
      session.cfg,
      {
        installationId: session.installationId,
        owner: session.ctx.owner,
        repo: session.ctx.repo,
        prNumber: session.ctx.prNumber,
        workItemId: session.workItemId ?? null,
        headSha: session.ctx.headSha,
      },
      postedFingerprints,
    );
  }

  return {
    kind: "published",
    reviewId: review.id,
    delta: emptyDelta({
      accepted,
      suppressionFingerprints: acceptedFingerprints(accepted),
      inlineReviewIds: [review.id],
      postedInlineCount: posted.length,
    }),
  };
}
