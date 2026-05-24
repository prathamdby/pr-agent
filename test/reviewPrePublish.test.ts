import { describe, expect, it } from "vitest";
import { prepareReviewPayloadForPublish } from "../src/agent/reviewPrePublish.js";
import { PUBLIC_OUTPUT_REDACTION } from "../src/agent/publicOutputSanitizer.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";

describe("prepareReviewPayloadForPublish", () => {
  it("dedupes overlapping findings before publish", () => {
    const payload: ReviewPayload = {
      prCharacter: "Test.",
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 10,
          endLine: 12,
          title: "Second",
          detail: "d2",
          fixPrompt: "fix 2",
        },
        {
          severity: "P0",
          file: "src/a.ts",
          startLine: 11,
          endLine: 13,
          title: "First",
          detail: "d1",
          fixPrompt: "fix 1",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    };

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings).toHaveLength(1);
    expect(result.prepared.payload.findings[0]?.severity).toBe("P0");
    expect(result.prepared.dedupedCount).toBe(1);
  });

  it("sanitizes finding fields that match banned public-output patterns", () => {
    const payload: ReviewPayload = {
      prCharacter: "Test.",
      findings: [
        {
          severity: "P2",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Leaked structured publish failure",
          detail: "Structured publish failed after 1/3 attempt(s).",
          fixPrompt: "Fix the handler.",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    };

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.payload.findings[0]?.detail).toBe(PUBLIC_OUTPUT_REDACTION);
  });
});
