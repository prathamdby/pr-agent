import { describe, expect, it } from "vitest";
import { sameFilePublishedThreadHints } from "../src/review/orchestrator/sameFilePublishedThreadHints.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";

function finding(file: string, title: string): ReviewFinding {
  return {
    severity: "P1",
    file,
    startLine: 1,
    endLine: 1,
    title,
    detail: "detail",
  };
}

describe("sameFilePublishedThreadHints", () => {
  it("returns no hints when incoming is empty even if priors exist", () => {
    const priors = [finding("src/a.ts", "prior bug"), finding("src/b.ts", "other")];

    expect(sameFilePublishedThreadHints([], priors)).toEqual([]);
  });

  it("returns same-file priors for non-empty incoming", () => {
    const priors = [finding("src/a.ts", "prior bug"), finding("src/b.ts", "other")];
    const incoming = [finding("src/a.ts", "new bug")];

    expect(sameFilePublishedThreadHints(incoming, priors)).toEqual([
      { file: "src/a.ts", title: "prior bug", startLine: 1, endLine: 1 },
    ]);
  });
});
