import { dedupeReviewFindings } from "./reviewFindingDedup.js";
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
}): { ok: true; prepared: PreparedReviewPayload } | { ok: false; error: string } {
  const normalized = normalizeReviewPayload(params.payload);
  const deduped = dedupeReviewFindings(normalized.findings);
  const payload = sanitizeReviewPayload({ ...normalized, findings: deduped });
  const dedupedCount = normalized.findings.length - deduped.length;

  const validationError = validateReviewPayload({
    payload,
    cachedDiffIndex: params.cachedDiffIndex,
    maxInlineFindings: params.maxInlineFindings,
  });
  if (validationError) {
    return { ok: false, error: validationError };
  }

  return {
    ok: true,
    prepared: { payload, dedupedCount },
  };
}
