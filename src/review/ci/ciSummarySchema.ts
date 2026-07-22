import { z } from "zod";
import {
  REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS,
  REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS,
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_CI_SUMMARY_REASON_MAX_CHARS,
} from "../../settings/index.js";

/** Structured fields the CI-summary LLM must return (status/names come from server facts). */
function createCiSummaryLlmSchema() {
  return z.object({
    headline: z.string().min(1).max(REVIEW_CI_SUMMARY_HEADLINE_MAX_CHARS),
    failures: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          reason: z.string().min(1).max(REVIEW_CI_SUMMARY_REASON_MAX_CHARS),
          fixHint: z.string().min(1).max(REVIEW_CI_SUMMARY_FIX_HINT_MAX_CHARS),
        }),
      )
      .max(REVIEW_CI_SUMMARY_MAX_FAILURES),
  });
}

export const ciSummaryLlmSchema = createCiSummaryLlmSchema();
export type CiSummaryLlmFields = z.infer<typeof ciSummaryLlmSchema>;
