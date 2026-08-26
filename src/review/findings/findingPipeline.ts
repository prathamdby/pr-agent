import { AppError } from "../../errors/appError.js";
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
  type ReviewPayload,
} from "../reviewSchema.js";
import type { CheckoutCoverage } from "../../prWorkspace/localPrWorkspace.js";
import type { EvidenceLedger } from "./evidenceLedger.js";
import { assertFindingsHaveEvidence } from "./evidenceValidator.js";

export type PreparedReviewPayload = {
  readonly payload: ReviewPayload;
  readonly dedupedCount: number;
  readonly placements: readonly InlinePlacement[];
};

export type PreparedFindingTargets = {
  /** Fingerprinted placements before historical suppression and inline caps. */
  readonly planned: readonly FingerprintedInlinePlacement[];
  readonly placements: readonly FingerprintedInlinePlacement[];
  readonly inline: readonly FingerprintedInlinePlacement[];
  readonly summaryOnly: readonly FingerprintedInlinePlacement[];
  readonly dropped: {
    readonly suppressedInlineCount: number;
    readonly inlineCommentCapExcluded: number;
    readonly anchorUnresolved: number;
  };
};

function withRedactedFinding(placement: InlinePlacement, finding: ReviewFinding): InlinePlacement {
  const next: InlinePlacement = {
    finding,
    inlineLine: placement.inlineLine,
    inlinePosted: placement.inlinePosted,
  };
  if (placement.inlineCommentUrl == null) return next;
  return {
    finding,
    inlineLine: placement.inlineLine,
    inlinePosted: placement.inlinePosted,
    inlineCommentUrl: placement.inlineCommentUrl,
  };
}

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
  const normalized = normalizeReviewPayload(params.payload);
  const deduped = dedupeReviewFindings(normalized.findings);
  const minConfidence = params.reviewMinConfidence ?? 1;
  const confidenceFiltered = deduped.filter(
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
  const candidate = { ...normalized, findings: evidenceFiltered };
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
        code: "review.payload_redaction",
        message: "Review payload redaction lost finding identity",
      });
    }
    redactedFindingsByOriginal.set(finding, redactedFinding);
  }
  const placements = validation.placements.map((placement) => {
    const finding = redactedFindingsByOriginal.get(placement.finding);
    if (!finding) {
      throw new AppError({
        code: "review.payload_redaction",
        message: "Review payload redaction lost finding identity",
      });
    }
    return withRedactedFinding(placement, finding);
  });
  return {
    ok: true,
    prepared: { payload, dedupedCount, placements },
  };
}

export function prepareFindingsForPublish(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
  inlinePlacements?: readonly InlinePlacement[];
  storedInlineFingerprints?: readonly string[];
  crossPrSuppressionFingerprints?: readonly string[];
  maxInlineComments?: number;
}): PreparedFindingTargets {
  const plannedPlacements =
    params.inlinePlacements == null
      ? planInlinePlacements(params.payload.findings, params.cachedDiffIndex)
      : [...params.inlinePlacements];
  const planned = fingerprintInlinePlacements(plannedPlacements, "review");
  const suppressionFingerprints = [
    ...(params.storedInlineFingerprints ?? []),
    ...(params.crossPrSuppressionFingerprints ?? []),
  ];
  const suppression = suppressInlinePlacementsByFingerprint(planned, suppressionFingerprints);
  const inlineCap = applyInlineCommentCap(
    suppression.placements,
    params.maxInlineComments ?? MAX_INLINE_REVIEW_COMMENTS,
  );
  const placements = inlineCap.placements;

  return {
    planned,
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
