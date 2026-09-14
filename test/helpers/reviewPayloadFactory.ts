import type { ReviewPayload } from "../../src/review/reviewSchema.js";

const DEFAULT_REVIEW_PAYLOAD: ReviewPayload = {
  findings: [],
  size: "S",
  followUps: [],
};

export function makeReviewPayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    ...DEFAULT_REVIEW_PAYLOAD,
    ...overrides,
  };
}
