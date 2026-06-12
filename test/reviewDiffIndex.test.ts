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

  it("skips already ingested file patches", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -4,1 +4,1 @@", "+first"].join("\n"),
        },
      ],
    });
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: ["@@ -40,1 +40,1 @@", "+second"].join("\n"),
        },
      ],
    });

    expect(resolveInlineAnchorLine(index, "src/x.ts", 4, 4)).toBe(4);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 40, 40)).toBeNull();
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

  it("keeps adjacent two-hunk ranges contiguous", () => {
    const patch = ["@@ -5,1 +5,1 @@", "+code at line 5", "@@ -6,1 +6,1 @@", "+code at line 6"].join(
      "\n",
    );
    expect(parseCommentableRightLineRanges(patch)).toEqual([[5, 6]]);
  });

  it("keeps right-side ranges contiguous across deleted lines", () => {
    const patch = ["@@ -5,3 +5,2 @@", "+added", "-removed", " context"].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[5, 6]]);
  });

  it("ignores no-newline marker lines when advancing right-side line numbers", () => {
    const patch = ["@@ -4,1 +4,2 @@", " context", "+added"].join("\n");
    const patchWithMarker = [patch, "\\ No newline at end of file"].join("\n");
    expect(parseCommentableRightLineRanges(patchWithMarker)).toEqual(
      parseCommentableRightLineRanges(patch),
    );
  });

  it("treats zero-length context lines as commentable right-side lines", () => {
    const patch = ["@@ -10,2 +10,3 @@", "+added first", "", "+added second"].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[10, 12]]);
  });

  it("does not treat a trailing patch newline as an extra context line", () => {
    const patch = ["@@ -10,1 +10,1 @@", "+added", ""].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[10, 10]]);
  });

  it("does not treat empty split segments between hunks as context lines", () => {
    const patch = ["@@ -5,1 +5,1 @@", "+line5", "", "@@ -7,1 +7,1 @@", "+line7"].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([
      [5, 5],
      [7, 7],
    ]);
  });

  it("does not treat repeated trailing patch newlines as context lines", () => {
    const patch = ["@@ -10,1 +10,1 @@", "+added", "", ""].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[10, 10]]);
  });

  it("returns ranges before a malformed hunk header and stops anchoring", () => {
    const patch = ["@@ -4,1 +4,2 @@", " context", "+added", "@@ garbage @@", "+after"].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[4, 5]]);
  });

  it("returns ranges before an unrecognized patch line and stops anchoring", () => {
    const patch = ["@@ -4,1 +4,3 @@", " context", "*unknown", "+after"].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[4, 4]]);
  });

  it("ignores git file headers before the first hunk", () => {
    const patch = [
      "diff --git a/src.txt b/src.txt",
      "index 5626abf..f719efd 100644",
      "--- a/src.txt",
      "+++ b/src.txt",
      "@@ -1,1 +1,2 @@",
      " one",
      "+two",
    ].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[1, 2]]);
  });

  it("ignores rename metadata before the first hunk", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 86%",
      "rename from old.txt",
      "rename to new.txt",
      "index 5626abf..f719efd 100644",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1,1 +1,1 @@",
      "+renamed",
    ].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[1, 1]]);
  });

  it("ignores new-file metadata before the first hunk", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..f719efd",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,1 @@",
      "+added",
    ].join("\n");
    expect(parseCommentableRightLineRanges(patch)).toEqual([[1, 1]]);
  });

  it("returns empty ranges for empty patches and deletion-only patches", () => {
    const patch = ["@@ -4,2 +4,0 @@", "-removed", "-gone"].join("\n");
    expect(parseCommentableRightLineRanges("")).toEqual([]);
    expect(parseCommentableRightLineRanges(patch)).toEqual([]);
  });

  it("resolves anchors when hunks produce out-of-order commentable ranges", () => {
    const index = createCachedPrDiffIndex();
    ingestListPullRequestFilesResult(index, {
      files: [
        {
          filename: "src/x.ts",
          patch: [
            "@@ -1000000,1 +1000000,1 @@",
            "+line 1000000",
            "@@ -10,1 +10,1 @@",
            "+line 10",
          ].join("\n"),
        },
      ],
    });

    expect(resolveInlineAnchorLine(index, "src/x.ts", 5, 15)).toBe(10);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 1, 1_000_000_000)).toBe(10);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 11, 999_999)).toBeNull();
  });

  it("cachedDiffForLines omits gap lines from commentable ranges", () => {
    const index = cachedDiffForFiles([{ file: "src/x.ts", lines: [5, 7] }]);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 5, 5)).toBe(5);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 7, 7)).toBe(7);
    expect(resolveInlineAnchorLine(index, "src/x.ts", 6, 6)).toBeNull();
  });
});
