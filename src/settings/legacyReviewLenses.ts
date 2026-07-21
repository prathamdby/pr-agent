import type { ReviewMode } from "../review/reviewSchema.js";

/** Historical lens identifiers still present in DB rows and old GitHub comments. Never written by new code. */
export const LEGACY_REVIEW_LENSES = ["review-security", "review-quality", "review-tests"] as const;

export type LegacyReviewLens = (typeof LEGACY_REVIEW_LENSES)[number];
export type AnyReviewLens = ReviewMode | LegacyReviewLens;

export const LEGACY_REVIEW_SUMMARY_SENTINELS = [
  "## PR Agent Security Review",
  "## PR Agent Quality Review",
  "## PR Agent Tests Review",
] as const satisfies readonly string[];

export const LEGACY_REVIEW_POINTER_BODIES = [
  "See the security review summary in the PR conversation.",
  "See the code-quality review summary in the PR conversation.",
  "See the proposed test cases summary in the PR conversation.",
] as const satisfies readonly string[];
