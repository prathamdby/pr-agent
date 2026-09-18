import { reviewPayloadFromFindings, type ReviewPayload } from "../../src/review/reviewSchema.js";

const DEFAULT_REVIEW_PAYLOAD: ReviewPayload = {
  ...reviewPayloadFromFindings([]),
  size: "S",
};

export function makeReviewPayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    ...DEFAULT_REVIEW_PAYLOAD,
    ...overrides,
  };
}
