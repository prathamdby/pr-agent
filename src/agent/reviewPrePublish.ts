import { dedupeReviewFindings } from "./reviewFindingDedup.js";
import type { AnchorFailure } from "./reviewFindingValidator.js";
import { validateReviewPayload } from "./reviewFindingValidator.js";
import { sanitizeReviewPayload } from "./publicOutputSanitizer.js";
import { normalizeReviewPayload, type ReviewMode, type ReviewPayload } from "./reviewSchema.js";
import type { CachedPrDiffIndex } from "./reviewLocationValidation.js";

export type PreparedReviewPayload = {
  readonly payload: ReviewPayload;
  readonly dedupedCount: number;
};

export function prepareReviewPayloadForPublish(params: {
  payload: ReviewPayload;
  mode: ReviewMode;
  cachedDiffIndex?: CachedPrDiffIndex;
  maxInlineFindings?: number;
  enforceInlineAnchorValidation?: boolean;
}):
  | { ok: true; prepared: PreparedReviewPayload }
  | { ok: false; error: string; anchorFailures: readonly AnchorFailure[] } {
  const normalized = normalizeReviewPayload(params.payload);
  const deduped = dedupeReviewFindings(normalized.findings);
  const payload = sanitizeReviewPayload({ ...normalized, findings: deduped });
  const dedupedCount = normalized.findings.length - deduped.length;

  const validation = validateReviewPayload({
    payload,
    cachedDiffIndex: params.cachedDiffIndex,
    maxInlineFindings: params.maxInlineFindings,
    enforceInlineAnchorValidation: params.enforceInlineAnchorValidation,
  });
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.message,
      anchorFailures: validation.anchorFailures,
    };
  }

  return {
    ok: true,
    prepared: { payload, dedupedCount },
  };
}
