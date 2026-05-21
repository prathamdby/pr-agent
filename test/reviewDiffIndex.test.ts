import { describe, expect, it } from "vitest";
import {
  parseCommentableRightLineRanges,
  resolveInlineAnchorLine,
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/agent/reviewDiffIndex.js";

import { cachedDiffForFiles } from "./helpers/reviewPublishTestHelpers.js";

describe("reviewDiffIndex", () => {
  it("parses added and context RIGHT lines from unified diff", () => {
    const patch = ["@@ -10,3 +10,4 @@", " context line", "+added line", " unchanged context"].join(
      "\n",
    );

    expect(parseCommentableRightLineRanges(patch)).toEqual([[10, 12]]);
  });

  it("resolves first valid anchor inside finding range", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });

    expect(resolveInlineAnchorLine(index, "src/x.ts", 4, 5)).toBe(4);
    expect(resolveInlineAnchorLine(index, "src/missing.ts", 1, 1)).toBeNull();
  });

  it("mutates the same index object passed in", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n"),
        },
      ],
    });

    expect(index.files.size).toBe(1);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 4, 4)).toBe(4);
  });

  it("returns null when patch omitted", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: "src/x.ts", patchOmitted: true }],
    });
    expect(resolveInlineAnchorLine(index, "src/x.ts", 1, 1)).toBeNull();
  });

  it("does not treat gap lines as commentable when patch skips them", () => {
    const patch = ["@@ -5,1 +5,1 @@", "+code at line 5", "@@ -7,1 +7,1 @@", "+code at line 7"].join(
      "\n",
    );
    expect(parseCommentableRightLineRanges(patch)).toEqual([
      [5, 5],
      [7, 7],
    ]);
  });

  it("cachedDiffForLines omits gap lines from commentable ranges", () => {
    const index = cachedDiffForFiles([{ file: "src/x.ts", lines: [5, 7] }]);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 5, 5)).toBe(5);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 7, 7)).toBe(7);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 6, 6)).toBeNull();
  });
});
