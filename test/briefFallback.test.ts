import { describe, expect, it } from "vitest";
import { buildDeterministicBrief } from "../src/review/orchestrator/briefFallback.js";
import { createCachedPrDiffIndex } from "../src/review/placement/reviewDiffIndex.js";

describe("buildDeterministicBrief", () => {
  it("falls back when title and body are empty or whitespace", () => {
    const brief = buildDeterministicBrief({
      prTitle: "   ",
      prBody: "\n\t  ",
      cachedDiffIndex: createCachedPrDiffIndex(),
    });

    expect(brief.prIntent).toBe("Pull request: (untitled)");
  });

  it("uses trimmed title alone when body is blank", () => {
    const brief = buildDeterministicBrief({
      prTitle: "  Ship it  ",
      prBody: "  ",
      cachedDiffIndex: createCachedPrDiffIndex(),
    });

    expect(brief.prIntent).toBe("Pull request: Ship it");
  });

  it("caps prIntent at 2000 characters", () => {
    const body = "x".repeat(3_000);
    const brief = buildDeterministicBrief({
      prTitle: "Title",
      prBody: body,
      cachedDiffIndex: createCachedPrDiffIndex(),
    });

    expect(brief.prIntent.length).toBe(2000);
    expect(brief.prIntent.startsWith("Title\n\n")).toBe(true);
  });
});
