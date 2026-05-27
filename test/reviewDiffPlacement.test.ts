import { describe, expect, it } from "vitest";
import {
  downgradePlacementsAfterInlineFailure,
  isLineResolutionPublishError,
  planInlinePlacements,
} from "../src/agent/reviewDiffPlacement.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/agent/reviewDiffIndex.js";

describe("reviewDiffPlacement", () => {
  it("marks invalid anchors as summary-only", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });

    const placements = planInlinePlacements(
      [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Valid",
          detail: "d",
          fixPrompt: "fix",
        },
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 99,
          endLine: 99,
          title: "Invalid",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      index,
    );

    expect(placements[0]?.inlinePosted).toBe(true);
    expect(placements[1]?.inlinePosted).toBe(false);
    expect(placements[1]?.inlineCapEligible).toBe(true);
  });

  it("downgrades inline placements after GitHub inline publish failure", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });
    const placements = planInlinePlacements(
      [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Valid",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      index,
    );

    expect(placements[0]?.inlinePosted).toBe(true);
    const downgraded = downgradePlacementsAfterInlineFailure(placements);
    expect(downgraded[0]?.inlinePosted).toBe(false);
    expect(downgraded[0]?.inlineLine).toBe(4);
  });

  it("detects line-resolution publish errors without matching unrelated 422s", () => {
    expect(isLineResolutionPublishError(new Error("Line could not be resolved"))).toBe(true);
    expect(isLineResolutionPublishError(new Error("Validation Failed: 422"))).toBe(false);
  });

  it("marks both duplicate-key P1 findings as inline-cap-eligible without a count cap", () => {
    const shared = {
      severity: "P1" as const,
      file: "src/x.ts",
      startLine: 4,
      endLine: 4,
      title: "Same title",
    };
    const findings = [
      { ...shared, detail: "first", fixPrompt: "fix first" },
      { ...shared, detail: "second", fixPrompt: "fix second" },
    ];

    const placements = planInlinePlacements(findings, createCachedPrDiffIndex());

    expect(placements[0]?.inlineCapEligible).toBe(true);
    expect(placements[1]?.inlineCapEligible).toBe(true);
  });
});
