import crypto from "node:crypto";
import * as v from "valibot";
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
} from "../orchestrator/orchestratorTypes.js";
import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.js";
import type { EvidenceLedger } from "../findings/evidenceLedger.js";
import { safeUpsertFindingHistoryOpen } from "../../agentWork/findingHistoryRepository.js";
import { isDefinitelyNoAcceptanceReviewError } from "../../github/reviewErrors.js";
import { findPublishedThreadBatch } from "../../github/prSurfaceHelpers.js";
import { getOperationIntent } from "../../agentWork/operationIntentRepository.js";
import { snapshotFindingLedger, type RecoveryDecision } from "../recovery/reviewRecovery.js";
import type { CanonicalThreadDecision } from "../recovery/reviewRecoverySchema.js";
import { reviewArtifactInvalid } from "../recovery/reviewArtifacts.js";
import { evidenceForCachedFindings } from "../recovery/reviewCachedOutputs.js";
import { fenceForEpoch } from "../../agentWork/writeFence.js";

const publishedPlacementSchema = v.object({
  finding: v.object(reviewFindingEntries),
  inlineLine: v.nullable(v.number()),
  inlinePosted: v.boolean(),
  inlineCommentUrl: v.optional(v.string()),
  inlineFingerprint: v.string(),
});
const inlineResultSchema = v.object({
  review: v.optional(v.object({ id: v.number(), url: v.string() })),
  postedPlacements: v.array(publishedPlacementSchema),
  anchorDroppedPlacements: v.array(publishedPlacementSchema),
  lineResolutionFallback: v.boolean(),
});

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
      domain: "review",
      kind: "posted_placement_missing_line",
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
  const calculatedTargets = prepareFindingsForPublish({
    payload: prepared.prepared.payload,
    cachedDiffIndex: session.cachedDiffIndex,
    inlinePlacements: prepared.prepared.placements,
    storedInlineFingerprints: [...input.ledger.suppressionFingerprints],
    crossPrSuppressionFingerprints: input.crossPrSuppressionFingerprints,
    maxInlineComments: remainingInline,
  });
  const targets = saved
    ? {
        ...calculatedTargets,
        inline: saved.inline,
        dropped: {
          ...calculatedTargets.dropped,
          suppressedInlineCount: saved.counts.suppressed,
          inlineCommentCapExcluded: saved.counts.capDowngraded,
        },
      }
    : calculatedTargets;
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
      suppressionFingerprints: [...localDelta.suppressionFingerprints],
      inlineReviewIds: [...localDelta.inlineReviewIds],
    },
    inline: targets.inline.map((entry) => ({ ...entry })),
    footers: [...footers].map(([key, paths]) => [key, [...paths]]),
    resultKind,
    evidence: evidence ?? [],
    judgmentDegraded: session.recovery?.getJudgmentDegraded() ?? false,
    briefFallback: session.recovery?.getBriefFallback() ?? false,
    coverage: session.recovery?.getCoverage() ?? { kind: "full" },
    counts: {
      suppressed: targets.dropped.suppressedInlineCount,
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
        delta: { ...saved.localDelta, accepted: [], suppressionFingerprints: [] },
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
      source: input.source,
      ledger: input.ledger,
      budgetExhausted: true,
    });
    return finishLocal({
      kind: "budget_exhausted",
      delta: emptyDelta({
        accepted,
        suppressionFingerprints: acceptedFingerprints(accepted),
        threadBudgetExhausted: true,
      }),
    });
  }

  const acceptedBeforePublish = input.recoveryWithoutEvidence
    ? []
    : (saved?.localDelta.accepted ??
      acceptedSummaryPlacements({
        targets: targets.placements,
        planned: targets.planned,
        source: input.source,
        ledger: input.ledger,
      }));
  if (targets.inline.length === 0) {
    return finishLocal({
      kind: "empty",
      delta: emptyDelta({
        accepted: acceptedBeforePublish,
        suppressionFingerprints: acceptedFingerprints(acceptedBeforePublish),
      }),
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
        emptyDelta({
          accepted: acceptedBeforePublish,
          suppressionFingerprints: acceptedFingerprints(acceptedBeforePublish),
        }),
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
          if (found && session.recovery) {
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
            const postedPlacements = targets.inline.filter((placement) =>
              observed.some(
                (comment) =>
                  comment.path === placement.finding.file &&
                  comment.line === placement.inlineLine &&
                  comment.body ===
                    renderInlineThreadBody(
                      placement.finding,
                      session.ctx,
                      boundByKey.get(reviewFindingPlacementKey(placement.finding)) ?? [],
                    ),
              ),
            );
            if (postedPlacements.length !== observed.length) return { kind: "absent" as const };
            const postedKeys = new Set(
              postedPlacements.map((placement) => placement.inlineFingerprint),
            );
            const anchorDroppedPlacements = targets.inline
              .filter((placement) => !postedKeys.has(placement.inlineFingerprint))
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
          }
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

  await session.recovery?.settle(decision, review.id);

  if (session.agentEvents && !replay) {
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
