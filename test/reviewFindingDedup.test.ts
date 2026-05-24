import { describe, expect, it } from "vitest";
import { dedupeReviewFindings } from "../src/agent/reviewFindingDedup.js";
import type { ReviewFinding } from "../src/agent/reviewSchema.js";

describe("dedupeReviewFindings", () => {
  it("drops overlapping findings on the same file", () => {
    const first: ReviewFinding = {
      severity: "P0",
      file: "src/a.ts",
      startLine: 10,
      endLine: 12,
      title: "Race",
      detail: "d1",
      fixPrompt: "fix 1",
    };
    const second: ReviewFinding = {
      severity: "P1",
      file: "src/a.ts",
      startLine: 11,
      endLine: 13,
      title: "Same area",
      detail: "d2",
      fixPrompt: "fix 2",
    };
    const third: ReviewFinding = {
      severity: "P2",
      file: "src/b.ts",
      startLine: 1,
      endLine: 1,
      title: "Other file",
      detail: "d3",
      fixPrompt: "fix 3",
    };
    const deduped = dedupeReviewFindings([second, third, first]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.severity).toBe("P0");
    expect(deduped.some((f) => f.file === "src/b.ts")).toBe(true);
  });

  it("keeps non-overlapping lines on the same file", () => {
    const a: ReviewFinding = {
      severity: "P1",
      file: "src/a.ts",
      startLine: 1,
      endLine: 1,
      title: "A",
      detail: "d",
      fixPrompt: "fix",
    };
    const b: ReviewFinding = {
      severity: "P2",
      file: "src/a.ts",
      startLine: 20,
      endLine: 20,
      title: "B",
      detail: "d",
      fixPrompt: "fix",
    };
    expect(dedupeReviewFindings([a, b])).toHaveLength(2);
  });
});
