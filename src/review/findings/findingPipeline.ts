import { MAX_INLINE_REVIEW_COMMENTS, REVIEW_SEVERITY_RANK } from "../../settings/index.js";
import type { AnchorFailure } from "./reviewFindingValidator.js";
import { validateReviewPayload } from "./reviewFindingValidator.js";
import { redactReviewPayloadSecrets } from "./reviewPublicOutput.js";
import { dedupeReviewFindings } from "./reviewFindingDedup.js";
import {
  fingerprintInlinePlacements,
  suppressInlinePlacementsByFingerprint,
} from "./reviewFindingFingerprint.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  applyInlineCommentCap,
  planInlinePlacements,
  type FingerprintedInlinePlacement,
  type InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import {
  isInlineSeverity,
  normalizeReviewPayload,
  type ReviewFinding,
  type ReviewMode,
  type ReviewPayload,
} from "../reviewSchema.js";

export type PreparedReviewPayload = {
  readonly payload: ReviewPayload;
  readonly dedupedCount: number;
  readonly placements: readonly InlinePlacement[];
};

export type PreparedFindingTargets = {
  readonly placements: readonly FingerprintedInlinePlacement[];
  readonly inline: readonly FingerprintedInlinePlacement[];
  readonly summaryOnly: readonly FingerprintedInlinePlacement[];
  readonly dropped: {
    readonly suppressedInlineCount: number;
    readonly inlineCommentCapExcluded: number;
    readonly anchorUnresolved: number;
  };
};

function passesSeverityFloor(severity: ReviewFinding["severity"], severityFloor?: number): boolean {
  if (severityFloor == null) return true;
  return REVIEW_SEVERITY_RANK[severity] <= severityFloor;
}

export function prepareReviewPayloadForPublish(params: {
  payload: ReviewPayload;
  mode: ReviewMode;
  reviewMinConfidence?: number;
  severityFloor?: number;
  cachedDiffIndex?: CachedPrDiffIndex;
  enforceInlineAnchorValidation?: boolean;
}):
  | { ok: true; prepared: PreparedReviewPayload }
  | { ok: false; error: string; anchorFailures: readonly AnchorFailure[] } {
  const normalized = normalizeReviewPayload(params.payload);
  const deduped = dedupeReviewFindings(normalized.findings);
  const minConfidence = params.reviewMinConfidence ?? 1;
  const confidenceFiltered = deduped.filter(
    (finding) => finding.confidence == null || finding.confidence >= minConfidence,
  );
  const severityFiltered = confidenceFiltered.filter((finding) =>
    passesSeverityFloor(finding.severity, params.severityFloor),
  );
  const candidate = { ...normalized, findings: severityFiltered };
  const dedupedCount = normalized.findings.length - deduped.length;

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
  const redactedFindingsByOriginal = new Map(
    candidate.findings.map((finding, index) => [finding, payload.findings[index] ?? finding]),
  );
  const placements = validation.placements.map((placement) => ({
    ...placement,
    finding: redactedFindingsByOriginal.get(placement.finding) ?? placement.finding,
  }));
  return {
    ok: true,
    prepared: { payload, dedupedCount, placements },
  };
}

export function prepareFindingsForPublish(params: {
  payload: ReviewPayload;
  mode: ReviewMode;
  cachedDiffIndex?: CachedPrDiffIndex;
  inlinePlacements?: readonly InlinePlacement[];
  storedInlineFingerprints?: readonly string[];
  maxInlineComments?: number;
}): PreparedFindingTargets {
  const plannedPlacements =
    params.inlinePlacements == null
      ? planInlinePlacements(params.payload.findings, params.cachedDiffIndex)
      : [...params.inlinePlacements];
  const fingerprintedPlacements = fingerprintInlinePlacements(plannedPlacements, params.mode);
  const suppression = suppressInlinePlacementsByFingerprint(
    fingerprintedPlacements,
    params.storedInlineFingerprints ?? [],
  );
  const inlineCap = applyInlineCommentCap(
    suppression.placements,
    params.maxInlineComments ?? MAX_INLINE_REVIEW_COMMENTS,
  );
  const placements = inlineCap.placements;

  return {
    placements,
    inline: placements.filter((placement) => placement.inlinePosted),
    summaryOnly: placements.filter((placement) => !placement.inlinePosted),
    dropped: {
      suppressedInlineCount: suppression.suppressedInlineCount,
      inlineCommentCapExcluded: inlineCap.inlineCommentCapExcluded,
      anchorUnresolved: placements.filter(
        (placement) => isInlineSeverity(placement.finding.severity) && placement.inlineLine == null,
      ).length,
    },
  };
}
