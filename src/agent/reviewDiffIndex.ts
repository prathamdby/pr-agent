export type CommentableRightLineRanges = Array<[number, number]>;

export type CachedPrFileDiff = {
  readonly patchOmitted: boolean;
  readonly commentableRightLineRanges: CommentableRightLineRanges;
};

export type CachedPrDiffIndex = {
  truncated: boolean;
  files: Map<string, CachedPrFileDiff>;
};

export function createCachedPrDiffIndex(): CachedPrDiffIndex {
  return { truncated: false, files: new Map() };
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
