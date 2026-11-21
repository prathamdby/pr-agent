import crypto from "node:crypto";
import * as v from "valibot";
import {
  type IdentifiedInlinePlacement,
  type InlinePlacement,
  reviewFindingPlacementKey,
} from "../placement/reviewDiffPlacement.ts";
import { cappedReaffirmedSeverity } from "../findingIdentity/findingLifecycle.ts";
import { parseOwnedFindingMarker, type FindingId } from "../findingIdentity/findingMarker.ts";
import type { FindingInventory } from "../findingIdentity/findingInventory.ts";
import type { ReconcileOutcome } from "../findingIdentity/findingReconcile.ts";
import { publishInlineReviewComments } from "../placement/reviewInlinePublish.ts";
import {
  renderInlineThreadBody,
  renderReviewPointerLensMarker,
  renderSpecialistReviewBody,
} from "../run/reviewRender.ts";
import { AppError } from "../../errors/appError.ts";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
  type PlacementIdentity,
} from "../findings/findingPipeline.ts";
import {
  reviewFindingEntries,
  type CoverageGapCeiling,
  type ReviewFinding,
} from "../reviewSchema.ts";
import { reviewPayloadFromFindings } from "../reviewSchema.ts";
import type { RepoPolicyResult } from "../repoPolicy.ts";
import { resolveBoundPolicyFooters, type BoundPolicyJudge } from "./boundPolicyJudge.ts";
import type { PublishStopReason, ReviewPublishSession } from "./reviewPublishSession.ts";
import {
  deterministicInlineBatchId,
  operationIntentMarker,
  reviewInlineBatchOperationKey,
  publishOnce,
} from "../../state/publish.ts";
import { safeEmitPublishEvent } from "../../agent/runtime/agentEventSink.ts";
import type {
  AcceptedPlacement,
  FindingLedger,
  FindingLedgerDelta,
  FindingSource,
  ReaffirmedFinding,
  SummaryOnlyReason,
} from "../orchestrator/orchestratorTypes.ts";
import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.ts";
import type { EvidenceLedger } from "../findings/evidenceLedger.ts";
import { isDefinitelyNoAcceptanceReviewError } from "../../github/reviewErrors.ts";
import { findPublishedThreadBatch } from "../../github/prSurfaceHelpers.ts";
import { findingIdSchema } from "../findingIdentity/findingMarker.ts";

const publishedPlacementSchema = v.object({
  finding: v.object(reviewFindingEntries),
  inlineLine: v.nullable(v.number()),
  inlinePosted: v.boolean(),
  inlineCommentUrl: v.optional(v.string()),
  findingId: findingIdSchema,
  reopens: v.optional(findingIdSchema),
  relatedLinks: v.optional(v.array(v.string())),
});
const inlineResultSchema = v.object({
  review: v.optional(v.object({ id: v.number(), url: v.string() })),
  postedPlacements: v.array(publishedPlacementSchema),
  anchorDroppedPlacements: v.array(publishedPlacementSchema),
  lineResolutionFallback: v.boolean(),
});

type StoredInlineBatch = {
  readonly version: 3;
  readonly batchId: string;
  readonly workItemId: string;
  readonly specialist: FindingSource;
  readonly headSha: string;
  readonly reviewId: number;
  readonly reviewUrl: string;
  readonly event: "COMMENT";
  readonly findingIds: readonly FindingId[];
  readonly placements: readonly {
    readonly finding: ReviewFinding;
    readonly resolvedLine: number;
    readonly findingId: FindingId;
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

export type FindingBatchInput = {
  readonly source: FindingSource;
  readonly ledger: FindingLedger;
  readonly evidenceLedger?: EvidenceLedger;
  readonly checkoutCoverage?: CheckoutCoverage;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly repoPolicy?: RepoPolicyResult;
  readonly policyBaseSha?: string | null;
  readonly boundPolicyJudge?: BoundPolicyJudge;
  readonly readCheckoutFile?: (path: string) => Promise<string | undefined>;
  readonly reconciled?: ReconciledFindings;
  readonly judged?: boolean;
  readonly coverageGapCeiling?: (
    finding: Pick<ReviewFinding, "file" | "startLine" | "endLine" | "title">,
  ) => CoverageGapCeiling | undefined;
};

export type ReconciledFindings = {
  readonly inventory: FindingInventory;
  readonly outcomes: ReadonlyMap<string, ReconcileOutcome>;
};

export function reconciledFindingKey(finding: ReviewFinding) {
  return ((pinnedReturn: string) => pinnedReturn)(
    JSON.stringify([reviewFindingPlacementKey(finding), finding.detail]),
  );
}

export function findingIdScope(
  session: Pick<ReviewPublishSession, "publish" | "workItemId" | "ctx">,
  source: FindingSource,
) {
  const workItemId = session.publish?.workItemId ?? session.workItemId;
  return ((pinnedReturn: readonly string[] | undefined) => pinnedReturn)(
    workItemId == null ? undefined : [workItemId, session.ctx.headSha, source],
  );
}

type ReconciledBatch = {
  readonly postable: readonly InlinePlacement[];
  readonly identify: (placement: InlinePlacement) => PlacementIdentity | undefined;
  readonly held: readonly {
    readonly placement: IdentifiedInlinePlacement;
    readonly reason: SummaryOnlyReason;
  }[];
  readonly reaffirmed: readonly ReaffirmedFinding[];
  readonly suppressedDismissedCount: number;
};

function emptyDelta(overrides?: Partial<FindingLedgerDelta>) {
  return ((pinnedReturn: FindingLedgerDelta) => pinnedReturn)({
    accepted: [],
    reaffirmed: [],
    suppressedDismissedCount: 0,
    inlineReviewIds: [],
    postedInlineCount: 0,
    threadCallCount: 1,
    threadBudgetExhausted: false,
    ...overrides,
  });
}

function reaffirmedFinding(
  placement: InlinePlacement,
  outcome: Extract<ReconcileOutcome, { kind: "reaffirm" }>,
  source: FindingSource,
  inventory: FindingInventory,
  judged: boolean,
  coverageGapCeiling: CoverageGapCeiling | undefined,
) {
  const held = inventory.findings.get(outcome.id);
  const base = {
    id: outcome.id,
    source,
    severity: cappedReaffirmedSeverity({
      held: held?.severity,
      observed: outcome.severity,
      testsLens: source === "tests",
      anchorPath: placement.finding.file,
      ...(held == null ? {} : { heldPath: held.path }),
      judged,
      ...(coverageGapCeiling == null ? {} : { coverageGapCeiling }),
    }),
    ...(judged ? {} : { judged: false }),
    ...(coverageGapCeiling == null ? {} : { coverageGapCeiling }),
  };
  if (held?.source === "thread") {
    return ((pinnedReturn: ReaffirmedFinding) => pinnedReturn)({
      ...base,
      heldBy: "thread",
      placement: {
        finding: placement.finding,
        inlineLine: held.line,
        inlinePosted: true,
        ...(held.url.length > 0 ? { inlineCommentUrl: held.url } : {}),
      },
    });
  }
  return ((pinnedReturn: ReaffirmedFinding) => pinnedReturn)({
    ...base,
    heldBy: held == null ? "run" : "summary",
    placement: { finding: placement.finding, inlineLine: null, inlinePosted: false },
  });
}

function reconcileBatch(
  placements: readonly InlinePlacement[],
  source: FindingSource,
  reconciled: ReconciledFindings | undefined,
  judged: boolean,
  coverageGapCeiling: (finding: ReviewFinding) => CoverageGapCeiling | undefined,
) {
  const identities = new Map<string, PlacementIdentity>();
  const identify = (placement: InlinePlacement) =>
    ((pinnedReturn: PlacementIdentity | undefined) => pinnedReturn)(
      identities.get(reconciledFindingKey(placement.finding)),
    );
  if (reconciled == null) {
    return ((pinnedReturn: ReconciledBatch) => pinnedReturn)({
      postable: placements,
      identify,
      held: [],
      reaffirmed: [],
      suppressedDismissedCount: 0,
    });
  }
  const postable: InlinePlacement[] = [];
  const held: { placement: IdentifiedInlinePlacement; reason: SummaryOnlyReason }[] = [];
  const reaffirmed: ReaffirmedFinding[] = [];
  let suppressedDismissedCount = 0;
  for (const placement of placements) {
    const key = reconciledFindingKey(placement.finding);
    const outcome = reconciled.outcomes.get(key);
    if (outcome == null) {
      postable.push(placement);
      continue;
    }
    switch (outcome.kind) {
      case "post_thread":
        identities.set(key, {
          findingId: outcome.id,
          ...(outcome.reopens != null ? { reopens: outcome.reopens } : {}),
          ...(outcome.relatedLinks.length > 0 ? { relatedLinks: outcome.relatedLinks } : {}),
        });
        postable.push(placement);
        break;
      case "promote":
        identities.set(key, { findingId: outcome.id });
        postable.push(placement);
        break;
      case "summary_only":
        held.push({ placement: { ...placement, findingId: outcome.id }, reason: outcome.reason });
        break;
      case "reaffirm":
        reaffirmed.push(
          reaffirmedFinding(
            placement,
            outcome,
            source,
            reconciled.inventory,
            judged,
            coverageGapCeiling(placement.finding),
          ),
        );
        break;
      case "suppressed_dismissed":
        suppressedDismissedCount += 1;
        break;
      default: {
        const exhaustive: never = outcome;
        return ((pinnedReturn: ReconciledBatch) => pinnedReturn)(exhaustive);
      }
    }
  }
  return ((pinnedReturn: ReconciledBatch) => pinnedReturn)({
    postable,
    identify,
    held,
    reaffirmed,
    suppressedDismissedCount,
  });
}

function ledgerPlacement({
  findingId: _findingId,
  reopens: _reopens,
  relatedLinks: _relatedLinks,
  ...placement
}: IdentifiedInlinePlacement) {
  return placement;
}

function summaryOnlyPlacement(
  placement: IdentifiedInlinePlacement,
  source: FindingSource,
  reason: SummaryOnlyReason,
) {
  return ((pinnedReturn: AcceptedPlacement) => pinnedReturn)({
    kind: "summary_only",
    source,
    placement: { ...ledgerPlacement(placement), inlinePosted: false },
    findingId: placement.findingId,
    reason,
    ...(placement.reopens != null ? { reopens: placement.reopens } : {}),
  });
}

function acceptedSummaryPlacements(params: {
  readonly targets: readonly IdentifiedInlinePlacement[];
  readonly planned: readonly IdentifiedInlinePlacement[];
  readonly batch: ReconciledBatch;
  readonly source: FindingSource;
  readonly budgetExhausted?: boolean;
}) {
  const plannedByKey = new Map(
    params.planned.map((placement) => [reviewFindingPlacementKey(placement.finding), placement]),
  );
  const held = params.batch.held.map(({ placement, reason }) =>
    summaryOnlyPlacement(placement, params.source, reason),
  );
  const fromTargets = params.targets.flatMap((placement) => {
    if (placement.inlinePosted && !params.budgetExhausted) return [];
    const planned = plannedByKey.get(reviewFindingPlacementKey(placement.finding));
    const reason = params.budgetExhausted ? "budget" : planned?.inlinePosted ? "cap" : "anchor";
    return [summaryOnlyPlacement(placement, params.source, reason)];
  });
  return ((pinnedReturn: AcceptedPlacement[]) => pinnedReturn)([...held, ...fromTargets]);
}

function storedPlacement(placement: IdentifiedInlinePlacement) {
  if (placement.inlineLine == null) {
    throw new AppError({
      domain: "review",
      kind: "posted_placement_missing_line",
      message: "Posted inline placement is missing its resolved line",
    });
  }
  return ((pinnedReturn: StoredInlineBatch["placements"][number]) => pinnedReturn)({
    finding: placement.finding,
    resolvedLine: placement.inlineLine,
    findingId: placement.findingId,
  });
}

export async function publishFindingBatch(
  batch: readonly ReviewFinding[],
  session: ReviewPublishSession,
  input: FindingBatchInput,
) {
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
      domain: "review",
      kind: "finding_batch_invalid",
      message: prepared.error,
    });
  }

  const remainingInline = Math.max(
    0,
    session.cfg.review.maxInlineComments - input.ledger.postedInlineCount,
  );
  const judged = input.judged !== false;
  const coverageGapCeiling = input.coverageGapCeiling ?? (() => undefined);
  const reconciledBatch = reconcileBatch(
    prepared.prepared.placements,
    input.source,
    input.reconciled,
    judged,
    coverageGapCeiling,
  );
  const intentWorkItemId = session.publish?.workItemId ?? session.workItemId;
  const targets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    cachedDiffIndex: session.cachedDiffIndex,
    inlinePlacements: reconciledBatch.postable,
    identify: reconciledBatch.identify,
    maxInlineComments: remainingInline,
    findingIdScope: findingIdScope(session, input.source),
  });
  const reconciledDelta = {
    reaffirmed: reconciledBatch.reaffirmed,
    suppressedDismissedCount: reconciledBatch.suppressedDismissedCount,
  };
  const suppressedCount =
    reconciledBatch.reaffirmed.length + reconciledBatch.suppressedDismissedCount;

  if (
    input.ledger.threadBudgetExhausted ||
    input.ledger.threadCallCount >= session.cfg.review.maxThreadPublishCalls
  ) {
    const accepted = acceptedSummaryPlacements({
      targets: targets.placements,
      planned: targets.planned,
      batch: reconciledBatch,
      source: input.source,
      budgetExhausted: true,
    });
    return ((pinnedReturn: FindingBatchResult) => pinnedReturn)({
      kind: "budget_exhausted",
      delta: emptyDelta({ accepted, ...reconciledDelta, threadBudgetExhausted: true }),
    });
  }

  const acceptedBeforePublish = acceptedSummaryPlacements({
    targets: targets.placements,
    planned: targets.planned,
    batch: reconciledBatch,
    source: input.source,
  });
  if (targets.inline.length === 0) {
    return ((pinnedReturn: FindingBatchResult) => pinnedReturn)({
      kind: "empty",
      delta: emptyDelta({ accepted: acceptedBeforePublish, ...reconciledDelta }),
    });
  }

  if (session.recordPublishStep && session.workItemId == null) {
    throw new AppError({
      domain: "review",
      kind: "work_item_id_required",
      message: "workItemId is required when recording an inline review batch",
    });
  }

  const stopReason = await session.stopReason();
  if (stopReason != null)
    return ((pinnedReturn: FindingBatchResult) => pinnedReturn)({
      kind: "stopped",
      reason: stopReason,
    });

  const progressCommentUrl = (await session.resolveProgressCommentUrl())?.trim();
  if (!progressCommentUrl) {
    throw new AppError({
      domain: "review",
      kind: "progress_comment_url_required",
      message:
        "Progress comment URL is required before publishing a specialist review batch; the progress stub must exist first",
    });
  }

  const batchId =
    intentWorkItemId != null
      ? deterministicInlineBatchId({
          workItemId: intentWorkItemId,
          headSha: session.ctx.headSha,
          findingIds: targets.inline.map((placement) => placement.findingId),
        })
      : crypto.randomUUID();
  const operationKey = reviewInlineBatchOperationKey(batchId);
  const operationMarker =
    intentWorkItemId == null ? null : operationIntentMarker(operationKey, intentWorkItemId);
  const boundByKey = await resolveBoundPolicyFooters({
    policy: input.repoPolicy ?? { kind: "absent" },
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
      renderCommentBody: (placement) =>
        renderInlineThreadBody(
          placement.finding,
          session.ctx,
          {
            id: placement.findingId,
            lens: input.source,
            reopens: placement.reopens,
            relatedLinks: placement.relatedLinks,
          },
          boundByKey.get(reviewFindingPlacementKey(placement.finding)) ?? [],
        ),
    });
  const recoverInline = async () => {
    if (operationMarker == null) return { found: false as const };
    const found = await findPublishedThreadBatch(
      session.prSurface,
      operationMarker,
      session.ctx.headSha,
    );
    if (found == null) return { found: false as const };
    const comments = await session.prSurface.listReviewComments();
    if (comments.truncated)
      throw new AppError({
        domain: "operation_intent",
        kind: "recovery_failed",
        message: "Review recovery needs a complete exact batch comment observation",
      });
    const observed = comments.comments.filter(
      (comment) => comment.pullRequestReviewId === found.reviewId && comment.inReplyToId == null,
    );
    if (observed.length === 0) return { found: false as const };
    const botLogin = await session.prSurface.getBotLogin();
    const plannedIds = new Set(targets.inline.map((placement) => placement.findingId));
    const postedIds = new Set<FindingId>();
    for (const comment of observed) {
      const marker = parseOwnedFindingMarker(
        { body: comment.body, authorLogin: comment.authorLogin, isRoot: true },
        botLogin,
      );
      if (marker == null || !plannedIds.has(marker.id) || postedIds.has(marker.id))
        return { found: false as const };
      postedIds.add(marker.id);
    }
    const postedPlacements = targets.inline.filter((placement) =>
      postedIds.has(placement.findingId),
    );
    const anchorDroppedPlacements = targets.inline
      .filter((placement) => !postedIds.has(placement.findingId))
      .map((placement) => ({ ...placement, inlinePosted: false }));
    return {
      found: true as const,
      value: {
        review: { id: found.reviewId, url: found.reviewUrl },
        postedPlacements,
        anchorDroppedPlacements,
        lineResolutionFallback: anchorDroppedPlacements.length > 0,
      },
    };
  };
  const publishStartedAt = Date.now();
  const target = session.publish;
  const inlineResult = await (target == null
    ? publishInline()
    : publishOnce<
        Awaited<ReturnType<typeof publishInlineReviewComments<IdentifiedInlinePlacement>>>
      >({
        db: target.db,
        workId: target.workItemId,
        prKey: target.resourceKey,
        resourceTarget: `inline_review:${batchId}`,
        ...(target.laneEpoch !== undefined ? { laneEpoch: target.laneEpoch } : {}),
        ...(target.shutdownRequested !== undefined
          ? { shutdownRequested: target.shutdownRequested }
          : {}),
        ...(target.signal !== undefined ? { signal: target.signal } : {}),
        decodeResult: (value) => {
          v.assert(inlineResultSchema, value);
          return value;
        },
        operationKey,
        mutationKind: "github.inline_review",
        identity: {
          step: "inline_review",
          resourceKey: target.resourceKey,
          reviewLens: input.source,
          batchId,
          operationMarker,
        },
        recover: recoverInline,
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
    return ((pinnedReturn: FindingBatchResult) => pinnedReturn)({
      kind: "empty",
      delta: emptyDelta({ accepted: acceptedWithoutPosted, ...reconciledDelta }),
    });
  }

  const postedAccepted: AcceptedPlacement[] = posted.map((placement) => ({
    kind: "posted",
    source: input.source,
    placement: ledgerPlacement(placement),
    findingId: placement.findingId,
    reviewId: review.id,
    ...(placement.reopens != null ? { reopens: placement.reopens } : {}),
  }));
  const accepted = [...acceptedWithoutPosted, ...postedAccepted];
  const batchRecord: StoredInlineBatch | undefined = session.workItemId
    ? {
        version: 3,
        batchId,
        workItemId: session.workItemId,
        specialist: input.source,
        headSha: session.ctx.headSha,
        reviewId: review.id,
        reviewUrl: review.url,
        event: "COMMENT",
        findingIds: posted.map((placement) => placement.findingId),
        placements: posted.map(storedPlacement),
        counts: {
          posted: posted.length,
          suppressed: suppressedCount,
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
      suppressedCount,
      capDowngraded: targets.dropped.inlineCommentCapExcluded,
      anchorDropped: inlineResult.anchorDroppedPlacements.length,
      latencyMs: publishLatencyMs,
    });
  }

  return ((pinnedReturn: FindingBatchResult) => pinnedReturn)({
    kind: "published",
    reviewId: review.id,
    delta: emptyDelta({
      accepted,
      ...reconciledDelta,
      inlineReviewIds: [review.id],
      postedInlineCount: posted.length,
    }),
  });
}
