import { reviewPayloadFromFindings, type ReviewPayload } from "../../src/review/reviewSchema.ts";

const DEFAULT_REVIEW_PAYLOAD: ReviewPayload = {
  ...reviewPayloadFromFindings([]),
  size: "S",
};

export function makeReviewPayload(overrides: Partial<ReviewPayload> = {}) {
  return ((pinnedReturn: ReviewPayload) => pinnedReturn)({
    ...DEFAULT_REVIEW_PAYLOAD,
    ...overrides,
  });
}
