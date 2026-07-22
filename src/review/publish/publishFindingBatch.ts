import crypto from "node:crypto";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
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
import { MAX_INLINE_REVIEW_COMMENTS, MAX_THREAD_PUBLISH_CALLS } from "../../settings/index.js";
import { AppError } from "../../errors/appError.js";
import {
  fingerprintCandidates,
  fingerprintInlinePlacements,
} from "../findings/reviewFindingFingerprint.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
} from "../findings/findingPipeline.js";
import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "../reviewSchema.js";
import type { RecordPublishStepWithCoordination } from "./publishSummaryOnly.js";
import type {
  AcceptedPlacement,
  FindingLedger,
  FindingLedgerDelta,
  FindingSource,
} from "../orchestrator/orchestratorTypes.js";

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
  | { readonly kind: "stopped"; readonly reason: "superseded" | "stale_head" };

export type FindingBatchContext = {
  readonly ctx: ReviewPublishContext;
  readonly source: FindingSource;
  readonly workItemId?: string;
  /** URL of the review progress comment (progress stub / final summary). Required to publish. */
  readonly progressCommentUrl?: string;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly refreshLiveAuth?: () => Promise<void>;
  readonly cachedDiffIndex: CachedPrDiffIndex;
  readonly recordPublishStep?: RecordPublishStepWithCoordination;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { readonly staleHead?: boolean };
  readonly ledger: FindingLedger;
};

function batchPayload(findings: readonly ReviewFinding[]): ReviewPayload {
  return {
    prCharacter: "Incremental review findings.",
    findings: [...findings],
    estimatedEffort: 1,
    relevantTests: "no",
    securityConcerns: null,
    followUps: [],
  };
}

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
  context: FindingBatchContext,
): Promise<FindingBatchResult> {
  const prepared = prepareReviewPayloadForPublish({
    payload: batchPayload(batch),
    cachedDiffIndex: context.cachedDiffIndex,
    enforceInlineAnchorValidation: false,
  });
  if (!prepared.ok) {
    throw new AppError({
      code: "review.finding_batch_invalid",
      message: prepared.error,
    });
  }

  const remainingInline = Math.max(
    0,
    MAX_INLINE_REVIEW_COMMENTS - context.ledger.postedInlineCount,
  );
  const targets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    cachedDiffIndex: context.cachedDiffIndex,
    inlinePlacements: prepared.prepared.placements,
    storedInlineFingerprints: [...context.ledger.suppressionFingerprints],
    maxInlineComments: remainingInline,
  });
  const planned = fingerprintInlinePlacements(prepared.prepared.placements, "review");

  if (
    context.ledger.threadBudgetExhausted ||
    context.ledger.threadCallCount >= MAX_THREAD_PUBLISH_CALLS
  ) {
    const accepted = acceptedSummaryPlacements({
      targets: targets.placements,
      planned,
      source: context.source,
      ledger: context.ledger,
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
    planned,
    source: context.source,
    ledger: context.ledger,
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

  if (context.recordPublishStep && context.workItemId == null) {
    throw new AppError({
      code: "review.work_item_id_required",
      message: "workItemId is required when recording an inline review batch",
    });
  }

  const shouldAbort = (await context.shouldAbortPublish?.()) ?? false;
  if (shouldAbort) {
    return {
      kind: "stopped",
      reason: context.publishAbortState?.staleHead === true ? "stale_head" : "superseded",
    };
  }

  const progressCommentUrl = context.progressCommentUrl?.trim();
  if (!progressCommentUrl) {
    throw new AppError({
      code: "review.progress_comment_url_required",
      message:
        "Progress comment URL is required before publishing a specialist review batch; the progress stub must exist first",
    });
  }

  const inlineResult = await publishInlineReviewComments(
    context.ctx.owner,
    context.ctx.repo,
    context.ctx.prNumber,
    {
      getToken: context.getToken,
      getTokenExpiresAtTs: context.getTokenExpiresAtTs,
      refreshLiveAuth: context.refreshLiveAuth,
      renderReviewBody: () =>
        renderSpecialistReviewBody({
          specialist: context.source,
          progressCommentUrl,
          lensMarker: renderReviewPointerLensMarker("review"),
        }),
      event: "COMMENT",
      commitId: context.ctx.headSha,
      inlinePlacements: targets.inline,
      renderCommentBody: (finding) => renderInlineThreadBody(finding, context.ctx),
    },
  );

  const posted = inlineResult.postedPlacements;
  const anchorDropped = inlineResult.anchorDroppedPlacements.map((placement) =>
    summaryOnlyPlacement(placement, context.source, "anchor"),
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
    source: context.source,
    placement,
    canonicalFingerprint: placement.inlineFingerprint,
    reviewId: review.id,
  }));
  const accepted = [...acceptedWithoutPosted, ...postedAccepted];
  const batchRecord: StoredInlineBatch | undefined = context.workItemId
    ? {
        version: 2,
        batchId: crypto.randomUUID(),
        workItemId: context.workItemId,
        specialist: context.source,
        headSha: context.ctx.headSha,
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
  if (context.recordPublishStep && batchRecord) {
    await context.recordPublishStep("inline_review", {
      githubId: review.id,
      meta: batchRecord,
    });
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
