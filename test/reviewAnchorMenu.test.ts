import { describe, expect, it } from "vitest";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  renderAnchorMenuBlock,
} from "../src/agent/reviewDiffIndex.js";
import { REVIEW_ANCHOR_MENU_BLOCK_LABEL } from "../src/settings/index.js";

describe("renderAnchorMenuBlock", () => {
  it("returns empty string for empty cache", () => {
    expect(
      renderAnchorMenuBlock(createCachedPrDiffIndex(), { maxFiles: 40, maxRangesPerFile: 20 }),
    ).toBe("");
  });

  it("wraps output in untrusted anchor_menu fence", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/a.ts",
          patch: ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });
    const block = renderAnchorMenuBlock(index, { maxFiles: 40, maxRangesPerFile: 20 });
    expect(block).toContain(`<${REVIEW_ANCHOR_MENU_BLOCK_LABEL} untrusted="true">`);
    expect(block).toContain(`</${REVIEW_ANCHOR_MENU_BLOCK_LABEL}>`);
    expect(block).toContain("src/a.ts:");
  });

  it("truncates files with suffix", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/a.ts",
          patch: ["@@ -1,1 +1,6 @@", "+1", "+2", "+3", "+4", "+5", "+6"].join("\n"),
        },
        {
          filename: "src/b.ts",
          patch: ["@@ -1,1 +1,2 @@", "+1", "+2"].join("\n"),
        },
      ],
    });
    const block = renderAnchorMenuBlock(index, { maxFiles: 1, maxRangesPerFile: 10 });
    expect(block).toContain("…1 more files");
  });
});
