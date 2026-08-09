import * as v from "valibot";
import {
  REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS,
  REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS,
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_REASON_MAX_CHARS,
} from "../../settings/index.js";

/** Structured fields the CI-summary LLM must return (status/names come from server facts). */
export const ciSummaryLlmSchema = v.object({
  headline: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS)),
  failures: v.pipe(
    v.array(
      v.object({
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        reason: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_CI_SUMMARY_REASON_MAX_CHARS)),
        fixHint: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS),
        ),
      }),
    ),
    v.maxLength(REVIEW_CI_SUMMARY_MAX_FAILURES),
  ),
});
export type CiSummaryLlmFields = v.InferOutput<typeof ciSummaryLlmSchema>;
