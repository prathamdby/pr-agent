import { AppError } from "../../errors/appError.ts";
import { MAX_INLINE_REVIEW_COMMENTS, REVIEW_SEVERITY_RANK } from "../../settings/index.ts";
import type { AnchorFailure } from "./reviewFindingValidator.ts";
import { validateReviewPayload } from "./reviewFindingValidator.ts";
import { redactReviewPayloadSecrets } from "./reviewPublicOutput.ts";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.ts";
import {
  applyInlineCommentCap,
  planInlinePlacements,
  reviewFindingPlacementKey,
  type IdentifiedInlinePlacement,
  type InlinePlacement,
} from "../placement/reviewDiffPlacement.ts";
import { derivedFindingId, mintFindingId } from "../findingIdentity/findingMarker.ts";
import { isInlineSeverity, type ReviewFinding, type ReviewPayload } from "../reviewSchema.ts";
import type { CheckoutCoverage } from "../../prWorkspace/repositoryReader.ts";
import type { EvidenceLedger } from "./evidenceLedger.ts";
import { assertFindingsHaveEvidence } from "./evidenceValidator.ts";

export type PreparedReviewPayload = {
  readonly payload: ReviewPayload;
  readonly placements: readonly InlinePlacement[];
};

export type PreparedFindingTargets = {
  readonly planned: readonly IdentifiedInlinePlacement[];
  readonly placements: readonly IdentifiedInlinePlacement[];
  readonly inline: readonly IdentifiedInlinePlacement[];
  readonly summaryOnly: readonly IdentifiedInlinePlacement[];
  readonly dropped: {
    readonly inlineCommentCapExcluded: number;
    readonly anchorUnresolved: number;
  };
};

export function prepareReviewPayloadForPublish(params: {
  payload: ReviewPayload;
  reviewMinConfidence?: number;
  severityFloor?: number;
  cachedDiffIndex?: CachedPrDiffIndex;
  enforceInlineAnchorValidation?: boolean;
  evidenceLedger?: EvidenceLedger;
  headSha?: string;
  checkoutCoverage?: CheckoutCoverage;
  isPathInCheckout?: (path: string) => boolean;
}):
  | { ok: true; prepared: PreparedReviewPayload }
  | { ok: false; error: string; anchorFailures: readonly AnchorFailure[] } {
  const minConfidence = params.reviewMinConfidence ?? 1;
  const confidenceFiltered = params.payload.findings.filter(
    (finding) => finding.confidence == null || finding.confidence >= minConfidence,
  );
  const severityFiltered = confidenceFiltered.filter((finding) => {
    if (params.severityFloor == null) return true;
    return REVIEW_SEVERITY_RANK[finding.severity] <= params.severityFloor;
  });
  const evidenceFiltered =
    params.evidenceLedger != null && params.headSha != null
      ? assertFindingsHaveEvidence(severityFiltered, params.evidenceLedger, params.headSha, {
          checkoutCoverage: params.checkoutCoverage,
          isPathInCheckout: params.isPathInCheckout,
        }).accepted
      : severityFiltered;
  const candidate = { ...params.payload, findings: evidenceFiltered };

  const validation = validateReviewPayload({
    payload: candidate,
    cachedDiffIndex: params.cachedDiffIndex,
    enforceInlineAnchorValidation: params.enforceInlineAnchorValidation,
  });
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.message,
      anchorFailures: validation.anchorFailures,
    };
  }

  const payload = redactReviewPayloadSecrets(candidate);
  if (payload.findings.length !== candidate.findings.length) {
    return {
      ok: false,
      error: "Review payload redaction changed finding count",
      anchorFailures: [],
    };
  }
  const redactedFindingsByOriginal = new Map<ReviewFinding, ReviewFinding>();
  for (const [index, finding] of candidate.findings.entries()) {
    const redactedFinding = payload.findings[index];
    if (!redactedFinding) {
      throw new AppError({
        domain: "review",
        kind: "payload_redaction",
        message: "Review payload redaction lost finding identity",
      });
    }
    redactedFindingsByOriginal.set(finding, redactedFinding);
  }
  const placements = validation.placements.map((placement) => {
    const finding = redactedFindingsByOriginal.get(placement.finding);
    if (!finding) {
      throw new AppError({
        domain: "review",
        kind: "payload_redaction",
        message: "Review payload redaction lost finding identity",
      });
    }
    return { ...placement, finding };
  });
  return {
    ok: true,
    prepared: { payload, placements },
  };
}

export type PlacementIdentity = Pick<
  IdentifiedInlinePlacement,
  "findingId" | "reopens" | "relatedLinks"
>;

export function prepareFindingsForPublish(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
  inlinePlacements?: readonly InlinePlacement[];
  identify?: (placement: InlinePlacement) => PlacementIdentity | undefined;
  maxInlineComments?: number;
  findingIdScope?: readonly string[];
}): PreparedFindingTargets {
  const plannedPlacements =
    params.inlinePlacements == null
      ? planInlinePlacements(params.payload.findings, params.cachedDiffIndex)
      : [...params.inlinePlacements];
  const occurrences = new Map<string, number>();
  const planned = plannedPlacements.map((placement): IdentifiedInlinePlacement => {
    const placementKey = reviewFindingPlacementKey(placement.finding);
    const occurrence = occurrences.get(placementKey) ?? 0;
    occurrences.set(placementKey, occurrence + 1);
    const identity = params.identify?.(placement);
    if (identity != null) return { ...placement, ...identity };
    if (params.findingIdScope == null) return { ...placement, findingId: mintFindingId() };
    return {
      ...placement,
      findingId: derivedFindingId([...params.findingIdScope, placementKey, String(occurrence)]),
    };
  });
  const inlineCap = applyInlineCommentCap(
    planned,
    params.maxInlineComments ?? MAX_INLINE_REVIEW_COMMENTS,
  );
  const placements = inlineCap.placements;

  return {
    planned,
    placements,
    inline: placements.filter((placement) => placement.inlinePosted),
    summaryOnly: placements.filter((placement) => !placement.inlinePosted),
    dropped: {
      inlineCommentCapExcluded: inlineCap.inlineCommentCapExcluded,
      anchorUnresolved: placements.filter(
        (placement) => isInlineSeverity(placement.finding.severity) && placement.inlineLine == null,
      ).length,
    },
  };
}
