import crypto from "node:crypto";
import * as v from "valibot";
import {
  type IdentifiedInlinePlacement,
  type InlinePlacement,
  reviewFindingPlacementKey,
} from "../placement/reviewDiffPlacement.js";
import { parseOwnedFindingMarker, type FindingId } from "../findingIdentity/findingMarker.js";
import type { FindingInventory } from "../findingIdentity/findingInventory.js";
import type { ReconcileOutcome } from "../findingIdentity/findingReconcile.js";
import { publishInlineReviewComments } from "../placement/reviewInlinePublish.js";
import {
  renderInlineThreadBody,
  renderReviewPointerLensMarker,
  renderSpecialistReviewBody,
} from "../run/reviewRender.js";
import { AppError } from "../../errors/appError.js";
import { fingerprintInlinePlacements } from "../findings/reviewFindingFingerprint.js";
import {
  prepareFindingsForPublish,
  prepareReviewPayloadForPublish,
  type PlacementIdentity,
} from "../findings/findingPipeline.js";
import { reviewFindingEntries, type ReviewFinding } from "../reviewSchema.js";
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
  ReaffirmedFinding,
  SummaryOnlyReason,
} from "../orchestrator/orchestratorTypes.js";
import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.js";
import type { EvidenceLedger } from "../findings/evidenceLedger.js";
import { safeUpsertFindingHistoryOpen } from "../../agentWork/findingHistoryRepository.js";
import { isDefinitelyNoAcceptanceReviewError } from "../../github/reviewErrors.js";
import { findPublishedThreadBatch } from "../../github/prSurfaceHelpers.js";
import { getOperationIntent } from "../../agentWork/operationIntentRepository.js";
import { snapshotFindingLedger, type RecoveryDecision } from "../recovery/reviewRecovery.js";
import { findingIdSchema, type CanonicalThreadDecision } from "../recovery/reviewRecoverySchema.js";
import { reviewArtifactInvalid } from "../recovery/reviewArtifacts.js";
import { evidenceForCachedFindings } from "../recovery/reviewCachedOutputs.js";
import { fenceForEpoch } from "../../agentWork/writeFence.js";

const publishedPlacementSchema = v.object({
  finding: v.object(reviewFindingEntries),
  inlineLine: v.nullable(v.number()),
  inlinePosted: v.boolean(),
  inlineCommentUrl: v.optional(v.string()),
  inlineFingerprint: v.string(),
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
  readonly fingerprints: readonly string[];
  readonly findingIds: readonly FindingId[];
  readonly placements: readonly {
    readonly finding: ReviewFinding;
    readonly resolvedLine: number;
    readonly canonicalFingerprint: string;
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
  readonly recoveryDecision?: RecoveryDecision;
  readonly recoveryWithoutEvidence?: boolean;
  readonly source: FindingSource;
  readonly ledger: FindingLedger;
  readonly evidenceLedger?: EvidenceLedger;
  readonly checkoutCoverage?: CheckoutCoverage;
  readonly isPathInCheckout?: (path: string) => boolean;
  readonly repoPolicy?: RepoPolicyResult;
  readonly sameRepo?: boolean;
  readonly boundPolicyJudge?: BoundPolicyJudge;
  readonly readCheckoutFile?: (path: string) => Promise<string | undefined>;
  readonly reconciled?: ReconciledFindings;
};

export type ReconciledFindings = {
  readonly inventory: FindingInventory;
  readonly outcomes: ReadonlyMap<string, ReconcileOutcome>;
};

export function reconciledFindingKey(finding: ReviewFinding): string {
  return JSON.stringify([reviewFindingPlacementKey(finding), finding.detail]);
}

export function findingIdScope(
  session: Pick<ReviewPublishSession, "operationIntent" | "workItemId" | "ctx">,
  source: FindingSource,
): readonly string[] | undefined {
  const workItemId = session.operationIntent?.workItemId ?? session.workItemId;
  return workItemId == null ? undefined : [workItemId, session.ctx.headSha, source];
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

function emptyDelta(overrides?: Partial<FindingLedgerDelta>): FindingLedgerDelta {
  return {
    accepted: [],
    reaffirmed: [],
    suppressedDismissedCount: 0,
    inlineReviewIds: [],
    postedInlineCount: 0,
    threadCallCount: 1,
    threadBudgetExhausted: false,
    ...overrides,
  };
}

function reaffirmedFinding(
  placement: InlinePlacement,
  outcome: Extract<ReconcileOutcome, { kind: "reaffirm" }>,
  source: FindingSource,
  inventory: FindingInventory,
): ReaffirmedFinding {
  const held = inventory.findings.get(outcome.id);
  const base = { id: outcome.id, source, severity: outcome.severity };
  if (held?.source === "thread") {
    return {
      ...base,
      heldBy: "thread",
      placement: {
        finding: placement.finding,
        inlineLine: held.line,
        inlinePosted: true,
        ...(held.url.length > 0 ? { inlineCommentUrl: held.url } : {}),
      },
    };
  }
  return {
    ...base,
    heldBy: held == null ? "run" : "summary",
    placement: { finding: placement.finding, inlineLine: null, inlinePosted: false },
  };
}

function reconcileBatch(
  placements: readonly InlinePlacement[],
  source: FindingSource,
  reconciled: ReconciledFindings | undefined,
): ReconciledBatch {
  const identities = new Map<string, PlacementIdentity>();
  const identify = (placement: InlinePlacement): PlacementIdentity | undefined =>
    identities.get(reconciledFindingKey(placement.finding));
  if (reconciled == null) {
    return {
      postable: placements,
      identify,
      held: [],
      reaffirmed: [],
      suppressedDismissedCount: 0,
    };
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
      case "summary_only": {
        const [fingerprinted] = fingerprintInlinePlacements([placement], "review");
        if (fingerprinted != null) {
          held.push({
            placement: { ...fingerprinted, findingId: outcome.id },
            reason: outcome.reason,
          });
        }
        break;
      }
      case "reaffirm":
        reaffirmed.push(reaffirmedFinding(placement, outcome, source, reconciled.inventory));
        break;
      case "suppressed_dismissed":
        suppressedDismissedCount += 1;
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  return { postable, identify, held, reaffirmed, suppressedDismissedCount };
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
): AcceptedPlacement {
  return {
    kind: "summary_only",
    source,
    placement: { ...ledgerPlacement(placement), inlinePosted: false },
    findingId: placement.findingId,
    canonicalFingerprint: placement.inlineFingerprint,
    reason,
    ...(placement.reopens != null ? { reopens: placement.reopens } : {}),
  };
}

function acceptedSummaryPlacements(params: {
  readonly targets: readonly IdentifiedInlinePlacement[];
  readonly planned: readonly IdentifiedInlinePlacement[];
  readonly batch: ReconciledBatch;
  readonly source: FindingSource;
  readonly budgetExhausted?: boolean;
}): AcceptedPlacement[] {
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
  return [...held, ...fromTargets];
}

function storedPlacement(
  placement: IdentifiedInlinePlacement,
): StoredInlineBatch["placements"][number] {
  if (placement.inlineLine == null) {
    throw new AppError({
      domain: "review",
      kind: "posted_placement_missing_line",
      message: "Posted inline placement is missing its resolved line",
    });
  }
  return {
    finding: placement.finding,
    resolvedLine: placement.inlineLine,
    canonicalFingerprint: placement.inlineFingerprint,
    findingId: placement.findingId,
  };
}

export async function publishFindingBatch(
  batch: readonly ReviewFinding[],
  session: ReviewPublishSession,
  input: FindingBatchInput,
): Promise<FindingBatchResult> {
  const replay = input.recoveryDecision;
  const canonical = replay?.prepared.artifact.canonical;
  if (canonical && canonical.kind !== "threads") reviewArtifactInvalid("decision_target");
  const saved = canonical?.kind === "threads" ? canonical : undefined;
  const prepared = prepareReviewPayloadForPublish({
    payload: replay?.prepared.artifact.payload ?? reviewPayloadFromFindings(batch),
    cachedDiffIndex: session.cachedDiffIndex,
    enforceInlineAnchorValidation: false,
    evidenceLedger: input.recoveryWithoutEvidence ? undefined : input.evidenceLedger,
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
  const reconciledBatch = reconcileBatch(
    prepared.prepared.placements,
    input.source,
    saved ? undefined : input.reconciled,
  );
  const intentWorkItemId = session.operationIntent?.workItemId ?? session.workItemId;
  const calculatedTargets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    cachedDiffIndex: session.cachedDiffIndex,
    inlinePlacements: reconciledBatch.postable,
    identify: reconciledBatch.identify,
    maxInlineComments: remainingInline,
    findingIdScope: findingIdScope(session, input.source),
  });
  const targets = saved
    ? {
        ...calculatedTargets,
        inline: saved.inline,
        dropped: {
          ...calculatedTargets.dropped,
          inlineCommentCapExcluded: saved.counts.capDowngraded,
        },
      }
    : calculatedTargets;
  const reconciledDelta = input.recoveryWithoutEvidence
    ? { reaffirmed: [], suppressedDismissedCount: 0 }
    : saved
      ? {
          reaffirmed: saved.localDelta.reaffirmed,
          suppressedDismissedCount: saved.localDelta.suppressedDismissedCount,
        }
      : {
          reaffirmed: reconciledBatch.reaffirmed,
          suppressedDismissedCount: reconciledBatch.suppressedDismissedCount,
        };
  const suppressedCount = saved
    ? saved.counts.suppressed
    : reconciledBatch.reaffirmed.length + reconciledBatch.suppressedDismissedCount;
  const evidence = input.evidenceLedger
    ? evidenceForCachedFindings(input.evidenceLedger, prepared.prepared.payload.findings)
    : prepared.prepared.payload.findings.length === 0
      ? []
      : null;
  const cacheable = evidence !== null;
  const plan = (
    localDelta: FindingLedgerDelta,
    resultKind: CanonicalThreadDecision["resultKind"],
    footers: ReadonlyMap<string, readonly string[]> = new Map(),
  ): CanonicalThreadDecision => ({
    kind: "threads",
    source: input.source,
    ledgerBefore: snapshotFindingLedger(input.ledger),
    localDelta: {
      ...localDelta,
      accepted: [...localDelta.accepted],
      reaffirmed: [...localDelta.reaffirmed],
      inlineReviewIds: [...localDelta.inlineReviewIds],
    },
    inline: targets.inline.map(({ relatedLinks, ...entry }) => ({
      ...entry,
      ...(relatedLinks != null ? { relatedLinks: [...relatedLinks] } : {}),
    })),
    footers: [...footers].map(([key, paths]) => [key, [...paths]]),
    resultKind,
    evidence: evidence ?? [],
    judgmentDegraded: session.recovery?.getJudgmentDegraded() ?? false,
    briefFallback: session.recovery?.getBriefFallback() ?? false,
    coverage: session.recovery?.getCoverage() ?? { kind: "full" },
    counts: {
      suppressed: suppressedCount,
      capDowngraded: targets.dropped.inlineCommentCapExcluded,
    },
  });
  const prepareDecision = async (operationKey: string, decision: CanonicalThreadDecision) => {
    if (replay) return replay;
    if (!cacheable) {
      session.recovery?.discardEvidenceCache();
      return null;
    }
    return (
      (await session.recovery?.prepare(prepared.prepared.payload, operationKey, decision)) ?? null
    );
  };
  const finishLocal = async (
    result: Extract<FindingBatchResult, { kind: "empty" | "budget_exhausted" }>,
  ) => {
    const decision = await prepareDecision(
      `local:${input.source}:${input.ledger.threadCallCount}`,
      saved ?? plan(result.delta, result.kind),
    );
    await session.recovery?.settle(decision);
    return result;
  };
  if (saved && saved.resultKind !== "remote") {
    if (input.recoveryWithoutEvidence)
      return {
        kind: saved.resultKind,
        delta: { ...saved.localDelta, ...reconciledDelta, accepted: [] },
      };
    return finishLocal({ kind: saved.resultKind, delta: saved.localDelta });
  }

  if (
    !saved &&
    (input.ledger.threadBudgetExhausted ||
      input.ledger.threadCallCount >= session.cfg.review.maxThreadPublishCalls)
  ) {
    const accepted = acceptedSummaryPlacements({
      targets: targets.placements,
      planned: targets.planned,
      batch: reconciledBatch,
      source: input.source,
      budgetExhausted: true,
    });
    return finishLocal({
      kind: "budget_exhausted",
      delta: emptyDelta({ accepted, ...reconciledDelta, threadBudgetExhausted: true }),
    });
  }

  const acceptedBeforePublish = input.recoveryWithoutEvidence
    ? []
    : (saved?.localDelta.accepted ??
      acceptedSummaryPlacements({
        targets: targets.placements,
        planned: targets.planned,
        batch: reconciledBatch,
        source: input.source,
      }));
  if (targets.inline.length === 0) {
    return finishLocal({
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
  if (stopReason != null) return { kind: "stopped", reason: stopReason };

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
  const operationKey =
    replay?.prepared.artifact.operationKey ?? reviewInlineBatchOperationKey(batchId);
  const operationMarker =
    intentWorkItemId == null ? null : operationIntentMarker(operationKey, intentWorkItemId);
  const boundByKey = saved
    ? new Map(saved.footers)
    : await resolveBoundPolicyFooters({
        policy: input.repoPolicy ?? { kind: "absent" },
        sameRepo: input.sameRepo,
        findings: targets.inline.map((placement) => placement.finding),
        judge: input.boundPolicyJudge,
        evidenceLedger: input.evidenceLedger,
        isPathInCheckout: input.isPathInCheckout,
        readCheckoutFile: input.readCheckoutFile,
      });
  const decision = await prepareDecision(
    operationKey,
    saved ??
      plan(
        emptyDelta({ accepted: acceptedBeforePublish, ...reconciledDelta }),
        "remote",
        boundByKey,
      ),
  );
  if (replay?.settled && session.operationIntent) {
    const intent = await getOperationIntent(
      session.operationIntent.client,
      session.operationIntent.workItemId,
      operationKey,
    );
    if (!intent) reviewArtifactInvalid("settled_receipt_missing");
  }
  if (replay && !session.operationIntent)
    reviewArtifactInvalid("recovery_receipt_boundary_missing");
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
  const publishStartedAt = Date.now();
  const inlineResult = await (session.operationIntent == null
    ? publishInline()
    : publishOnce<
        Awaited<ReturnType<typeof publishInlineReviewComments<IdentifiedInlinePlacement>>>
      >({
        decodeResult: (value) => {
          v.assert(inlineResultSchema, value);
          return value;
        },
        fence: fenceForEpoch(session.operationIntent.leaseEpoch),
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
          if (found == null) return { kind: "absent" as const };
          const comments = await session.prSurface.listReviewComments();
          if (comments.truncated)
            throw new AppError({
              domain: "operation_intent",
              kind: "recovery_failed",
              message: "Review recovery needs a complete exact batch comment observation",
            });
          const observed = comments.comments.filter(
            (comment) =>
              comment.pullRequestReviewId === found.reviewId && comment.inReplyToId == null,
          );
          if (observed.length === 0) return { kind: "absent" as const };
          const botLogin = await session.prSurface.getBotLogin();
          const plannedIds = new Set(targets.inline.map((placement) => placement.findingId));
          const postedIds = new Set<FindingId>();
          for (const comment of observed) {
            const marker = parseOwnedFindingMarker(
              { body: comment.body, authorLogin: comment.authorLogin, isRoot: true },
              botLogin,
            );
            if (marker == null || !plannedIds.has(marker.id) || postedIds.has(marker.id))
              return { kind: "absent" as const };
            postedIds.add(marker.id);
          }
          const postedPlacements = targets.inline.filter((placement) =>
            postedIds.has(placement.findingId),
          );
          const anchorDroppedPlacements = targets.inline
            .filter((placement) => !postedIds.has(placement.findingId))
            .map((placement) => ({ ...placement, inlinePosted: false }));
          return {
            kind: "reconciled" as const,
            value: {
              review: { id: found.reviewId, url: found.reviewUrl },
              postedPlacements,
              anchorDroppedPlacements,
              lineResolutionFallback: anchorDroppedPlacements.length > 0,
            },
          };
        },
        isKnownNoAcceptanceError: isDefinitelyNoAcceptanceReviewError,
        mutate: input.recoveryWithoutEvidence
          ? async () => reviewArtifactInvalid("recovery_evidence_miss")
          : publishInline,
      }));
  const publishLatencyMs = Math.max(0, Date.now() - publishStartedAt);

  const posted = inlineResult.postedPlacements;
  const anchorDropped = input.recoveryWithoutEvidence
    ? []
    : inlineResult.anchorDroppedPlacements.map((placement) =>
        summaryOnlyPlacement(placement, input.source, "anchor"),
      );
  const acceptedWithoutPosted = [...acceptedBeforePublish, ...anchorDropped];
  const review = inlineResult.review;
  if (!review) {
    await session.recovery?.settle(decision);
    return {
      kind: "empty",
      delta: emptyDelta({ accepted: acceptedWithoutPosted, ...reconciledDelta }),
    };
  }

  const postedAccepted: AcceptedPlacement[] = posted.map((placement) => ({
    kind: "posted",
    source: input.source,
    placement: ledgerPlacement(placement),
    findingId: placement.findingId,
    canonicalFingerprint: placement.inlineFingerprint,
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
        fingerprints: posted.map((placement) => placement.inlineFingerprint),
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

  await session.recovery?.settle(decision, review.id);

  if (session.agentEvents && !replay) {
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
      ...reconciledDelta,
      inlineReviewIds: [review.id],
      postedInlineCount: posted.length,
    }),
  };
}
