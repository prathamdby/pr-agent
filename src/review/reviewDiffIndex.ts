import { REVIEW_ANCHOR_MENU_BLOCK_LABEL } from "../settings/index.js";
import { wrapUntrustedBlock } from "../agent/askSafety.js";

export type CommentableRightLineRanges = Array<[number, number]>;

type CachedPrFileDiff = {
  readonly patchOmitted: boolean;
  readonly commentableRightLineRanges: CommentableRightLineRanges;
};

export type CachedPrDiffIndex = {
  truncated: boolean;
  files: Map<string, CachedPrFileDiff>;
  listPullRequestFilesIngested: boolean;
};

export function createCachedPrDiffIndex(): CachedPrDiffIndex {
  return { truncated: false, files: new Map(), listPullRequestFilesIngested: false };
}

/** Parse unified diff patch into contiguous RIGHT-side line ranges (additions + context). */
export function parseCommentableRightLineRanges(patch: string): CommentableRightLineRanges {
  const lines = new Set<number>();
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  let rightLine = 0;

  for (const rawLine of patch.split("\n")) {
    const hunkMatch = rawLine.match(hunkRe);
    if (hunkMatch) {
      rightLine = Number(hunkMatch[1]);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      lines.add(rightLine);
      rightLine++;
      continue;
    }
    if (rawLine.startsWith(" ") && rawLine.length > 0) {
      lines.add(rightLine);
      rightLine++;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      continue;
    }
    if (rawLine.startsWith("\\")) {
      continue;
    }
    if (rawLine.length > 0) {
      rightLine++;
    }
  }

  return compressLineRanges([...lines].toSorted((a, b) => a - b));
}

function compressLineRanges(sortedLines: number[]): CommentableRightLineRanges {
  if (sortedLines.length === 0) return [];
  const ranges: CommentableRightLineRanges = [];
  let start = sortedLines[0];
  let prev = start;
  for (let i = 1; i < sortedLines.length; i++) {
    const line = sortedLines[i];
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push([start, prev]);
    start = line;
    prev = line;
  }
  ranges.push([start, prev]);
  return ranges;
}

export type ListPullRequestFilesToolResult = {
  truncated?: boolean;
  files?: Array<{
    filename: string;
    patch?: string;
    patchOmitted?: boolean;
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
    const patchOmitted = file.patchOmitted === true || file.patch == null;
    const commentableRightLineRanges =
      !patchOmitted && file.patch ? parseCommentableRightLineRanges(file.patch) : [];
    index.files.set(file.filename, { patchOmitted, commentableRightLineRanges });
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

function lineInRanges(line: number, ranges: CommentableRightLineRanges): boolean {
  for (const [start, end] of ranges) {
    if (line >= start && line <= end) return true;
  }
  return false;
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
  for (let line = lo; line <= hi; line++) {
    if (lineInRanges(line, entry.commentableRightLineRanges)) return line;
  }
  return null;
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
    lines.push(`- ${filename}: ${formatted}${rangeSuffix}`);
  }
  if (entries.length > caps.maxFiles) {
    lines.push(`…${entries.length - caps.maxFiles} more files`);
  }
  if (index.truncated) {
    lines.push("(Change set was truncated; some files may be missing from this menu.)");
  }

  return wrapUntrustedBlock(REVIEW_ANCHOR_MENU_BLOCK_LABEL, lines.join("\n"));
}
