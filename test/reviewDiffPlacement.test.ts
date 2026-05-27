import { describe, expect, it } from "vitest";
import {
  applyInlineCommentCap,
  downgradePlacementsAfterInlineFailure,
  isLineResolutionPublishError,
  planInlinePlacements,
} from "../src/agent/reviewDiffPlacement.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/agent/reviewDiffIndex.js";
import { MAX_INLINE_REVIEW_COMMENTS } from "../src/settings/index.js";

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
    expect(placements[1]?.inlineLine).toBeNull();
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

  it("marks both duplicate-key P1 findings as inline candidates without a count cap", () => {
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

    expect(placements).toHaveLength(2);
    expect(placements.every((p) => p.inlineLine == null)).toBe(true);
  });

  it("caps inline comments by severity order", () => {
    const findings = Array.from({ length: MAX_INLINE_REVIEW_COMMENTS + 5 }, (_, i) => ({
      severity: i < 3 ? ("P0" as const) : ("P2" as const),
      file: `src/f${i}.ts`,
      startLine: i + 1,
      endLine: i + 1,
      title: `Bug ${i}`,
      detail: "d",
      fixPrompt: "fix",
    }));

    const placements = planInlinePlacements(findings, createCachedPrDiffIndex()).map((p) => ({
      ...p,
      inlinePosted: true,
      inlineLine: p.finding.startLine,
    }));

    const capped = applyInlineCommentCap(placements, MAX_INLINE_REVIEW_COMMENTS);
    expect(capped.inlineCommentCapExcluded).toBe(5);
    expect(capped.placements.filter((p) => p.inlinePosted)).toHaveLength(
      MAX_INLINE_REVIEW_COMMENTS,
    );
    expect(
      capped.placements.filter((p) => p.finding.severity === "P0" && p.inlinePosted),
    ).toHaveLength(3);
  });
});

describe("mergeDroppedIntoSummaryPlacements", () => {
  it("matches dropped placements by stable finding key, not object identity", async () => {
    const { mergeDroppedIntoSummaryPlacements } = await import("../src/agent/reviewDiffPlacement.js");
    const finding = {
      severity: "P1" as const,
      file: "src/a.ts",
      startLine: 1,
      endLine: 1,
      title: "Bug",
      detail: "detail",
      fixPrompt: "fix",
    };
    const placements = [{ finding, inlineLine: 1, inlinePosted: true }];
    const dropped = [{ finding: { ...finding }, inlineLine: 1, inlinePosted: false }];
    const merged = mergeDroppedIntoSummaryPlacements(placements, dropped);
    expect(merged[0]?.inlinePosted).toBe(false);
  });
});
