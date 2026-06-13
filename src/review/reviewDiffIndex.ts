import { REVIEW_ANCHOR_MENU_BLOCK_LABEL } from "../settings/index.js";
import { wrapUntrustedBlock } from "../agent/promptBlocks.js";
import { escapeTableHtml } from "../github/markdownFormat.js";

export type CommentableRightLineRanges = Array<[number, number]>;

type CachedPrFileDiff = {
  readonly patchOmitted: boolean;
  readonly commentableRightLineRanges: CommentableRightLineRanges;
  readonly additions: number;
  readonly deletions: number;
};

export type CachedPrDiffIndex = {
  truncated: boolean;
  files: Map<string, CachedPrFileDiff>;
  listPullRequestFilesIngested: boolean;
};

export function createCachedPrDiffIndex(): CachedPrDiffIndex {
  return {
    truncated: false,
    files: new Map(),
    listPullRequestFilesIngested: false,
  };
}

const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parse unified diff patch into contiguous RIGHT-side line ranges (additions + context). */
export function parseCommentableRightLineRanges(patch: string): CommentableRightLineRanges {
  const ranges: CommentableRightLineRanges = [];
  let rightLine = 0;
  let range: [number, number] | undefined;

  const addCommentableLine = (line: number) => {
    if (!range) {
      range = [line, line];
      return;
    }
    if (line === range[1] + 1) {
      range[1] = line;
      return;
    }
    ranges.push(range);
    range = [line, line];
  };

  const finishRanges = () => {
    if (range) {
      ranges.push(range);
    }
    return ranges;
  };

  if (patch === "") return ranges;

  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  let seenHunk = false;
  let rightLinesRemaining = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) {
      const hunkMatch = rawLine.match(DIFF_HUNK_RE);
      if (!hunkMatch) return finishRanges();
      rightLine = Number(hunkMatch[1]);
      rightLinesRemaining = Number(hunkMatch[2] ?? "1");
      seenHunk = true;
      continue;
    }
    if (!seenHunk) {
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      addCommentableLine(rightLine);
      rightLine++;
      rightLinesRemaining--;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      addCommentableLine(rightLine);
      rightLine++;
      rightLinesRemaining--;
      continue;
    }
    if (rawLine.length === 0) {
      if (rightLinesRemaining > 0) {
        addCommentableLine(rightLine);
        rightLine++;
        rightLinesRemaining--;
      }
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      continue;
    }
    if (rawLine.startsWith("\\")) {
      continue;
    }
    return finishRanges();
  }

  return finishRanges();
}

export type ListPullRequestFilesToolResult = {
  truncated?: boolean;
  files?: Array<{
    filename: string;
    patch?: string;
    patchOmitted?: boolean;
    additions?: number;
    deletions?: number;
  }>;
};

export function ingestListPullRequestFilesResult(
  index: CachedPrDiffIndex,
  result: ListPullRequestFilesToolResult,
): void {
  index.listPullRequestFilesIngested = true;
  if (result.truncated) {
    index.truncated = true;
  }
  for (const file of result.files ?? []) {
    if (index.files.has(file.filename)) continue;
    const patchOmitted = file.patchOmitted === true || file.patch == null || file.patch === "";
    const commentableRightLineRanges =
      !patchOmitted && file.patch ? parseCommentableRightLineRanges(file.patch) : [];
    index.files.set(file.filename, {
      patchOmitted,
      commentableRightLineRanges,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    });
  }
}

export function wrapListPullRequestFilesDiffIngestion(
  executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  cachedDiffIndex: CachedPrDiffIndex,
): void {
  const original = executors.listPullRequestFiles;
  if (!original) return;
  executors.listPullRequestFiles = async (args) => {
    const out = await original(args);
    cachedDiffIndex.listPullRequestFilesIngested = true;
    if (out && typeof out === "object") {
      ingestListPullRequestFilesResult(cachedDiffIndex, out as ListPullRequestFilesToolResult);
    }
    return out;
  };
}

/** Pick first commentable RIGHT line inside the finding range, or null for summary-only. */
export function resolveInlineAnchorLine(
  index: CachedPrDiffIndex | undefined,
  file: string,
  startLine: number,
  endLine: number,
): number | null {
  if (!index) return null;
  const entry = index.files.get(file);
  if (!entry || entry.patchOmitted || entry.commentableRightLineRanges.length === 0) return null;
  const lo = Math.min(startLine, endLine);
  const hi = Math.max(startLine, endLine);
  let anchor: number | null = null;
  for (const [start, end] of entry.commentableRightLineRanges) {
    if (end < lo || start > hi) continue;
    const candidate = Math.max(lo, start);
    if (anchor === null || candidate < anchor) {
      anchor = candidate;
    }
  }
  return anchor;
}

function formatRangePair([start, end]: [number, number]): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

export function renderAnchorMenuBlock(
  index: CachedPrDiffIndex,
  caps: { maxFiles: number; maxRangesPerFile: number },
): string {
  if (index.files.size === 0) return "";

  const entries = [...index.files.entries()].filter(
    ([, file]) => !file.patchOmitted && file.commentableRightLineRanges.length > 0,
  );
  if (entries.length === 0) return "";

  const lines = [
    "Use these commentable RIGHT-side line ranges when setting startLine/endLine on findings:",
  ];
  const shown = entries.slice(0, caps.maxFiles);
  for (const [filename, file] of shown) {
    const ranges = file.commentableRightLineRanges.slice(0, caps.maxRangesPerFile);
    const formatted = ranges.map(formatRangePair).join(", ");
    const rangeSuffix =
      file.commentableRightLineRanges.length > caps.maxRangesPerFile
        ? ` …${file.commentableRightLineRanges.length - caps.maxRangesPerFile} more ranges`
        : "";
    lines.push(`- ${escapeTableHtml(filename)}: ${formatted}${rangeSuffix}`);
  }
  if (entries.length > caps.maxFiles) {
    lines.push(`…${entries.length - caps.maxFiles} more files`);
  }
  if (index.truncated) {
    lines.push("(Change set was truncated; some files may be missing from this menu.)");
  }

  return wrapUntrustedBlock(REVIEW_ANCHOR_MENU_BLOCK_LABEL, lines.join("\n"));
}
