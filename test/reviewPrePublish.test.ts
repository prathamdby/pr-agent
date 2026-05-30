import { describe, expect, it } from "vitest";
import { prepareReviewPayloadForPublish } from "../src/review/reviewPrePublish.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";

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
          title: "Race",
          detail: "Same issue",
          fixPrompt: "fix 2",
        },
        {
          severity: "P0",
          file: "src/a.ts",
          startLine: 11,
          endLine: 13,
          title: "Race",
          detail: "Same issue",
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

  it("passes finding detail with internal failure phrasing through after secret scrub", () => {
    const payload: ReviewPayload = {
      prCharacter: "Test.",
      findings: [
        {
          severity: "P2",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Echoed failure",
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
    expect(result.prepared.payload.findings[0]?.detail).toBe(
      "Structured publish failed after 1/3 attempt(s).",
    );
  });

  it("rejects overview with internal failure phrasing instead of redacting", () => {
    const payload: ReviewPayload = {
      prCharacter: "Structured publish failed after 3/3 attempt(s). Check server logs.",
      findings: [],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    };

    const result = prepareReviewPayloadForPublish({ payload, mode: "review" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/prCharacter/);
  });

  it("scrubs secret assignments in prepared payload", () => {
    const payload: ReviewPayload = {
      prCharacter: "Test.",
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Secret in detail",
          detail: "Found DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent",
          fixPrompt: "Rotate credentials.",
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
    expect(result.prepared.payload.findings[0]?.detail).toContain("[redacted]");
    expect(result.prepared.payload.findings[0]?.detail).not.toContain("postgres://");
  });
});
