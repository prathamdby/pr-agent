import { describe, expect, it } from "vitest";
import {
  parseCommentableRightLineRanges,
  resolveInlineAnchorLine,
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
} from "../src/review/reviewDiffIndex.js";

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

  it("resolves large finding spans from sorted commentable ranges", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: [
            "@@ -10,1 +10,1 @@",
            "+line 10",
            "@@ -1000000,1 +1000000,1 @@",
            "+line 1000000",
          ].join("\n"),
        },
      ],
    });

    expect(resolveInlineAnchorLine(index, "src/x.ts", 1, 1_000_000_000)).toBe(10);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 11, 999_999)).toBeNull();
    expect(resolveInlineAnchorLine(index, "src/x.ts", 11, 1_000_000_000)).toBe(1_000_000);
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

  it("ignores no-newline marker lines when advancing right-side line numbers", () => {
    const patch = ["@@ -4,1 +4,2 @@", "+added", "\\ No newline at end of file"].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[4, 4]]);
  });

  it("cachedDiffForLines omits gap lines from commentable ranges", () => {
    const index = cachedDiffForFiles([{ file: "src/x.ts", lines: [5, 7] }]);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 5, 5)).toBe(5);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 7, 7)).toBe(7);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 6, 6)).toBeNull();
  });
});
