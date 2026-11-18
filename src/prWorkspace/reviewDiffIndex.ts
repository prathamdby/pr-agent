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

export function createCachedPrDiffIndex() {
  return ((pinnedReturn: CachedPrDiffIndex) => pinnedReturn)({
    truncated: false,
    files: new Map(),
    listPullRequestFilesIngested: false,
  });
}

const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseCommentableRightLineRanges(patch: string) {
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

  if (patch === "") return ((pinnedReturn: CommentableRightLineRanges) => pinnedReturn)(ranges);

  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  let seenHunk = false;
  let rightLinesRemaining = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith("@@")) {
      const hunkMatch = rawLine.match(DIFF_HUNK_RE);
      if (!hunkMatch)
        return ((pinnedReturn: CommentableRightLineRanges) => pinnedReturn)(finishRanges());
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
    return ((pinnedReturn: CommentableRightLineRanges) => pinnedReturn)(finishRanges());
  }

  return ((pinnedReturn: CommentableRightLineRanges) => pinnedReturn)(finishRanges());
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
) {
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

export function resolveInlineAnchorLine(
  index: CachedPrDiffIndex | undefined,
  file: string,
  startLine: number,
  endLine: number,
) {
  if (!index) return ((pinnedReturn: number | null) => pinnedReturn)(null);
  const entry = index.files.get(file);
  if (!entry || entry.patchOmitted || entry.commentableRightLineRanges.length === 0)
    return ((pinnedReturn: number | null) => pinnedReturn)(null);
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
  return ((pinnedReturn: number | null) => pinnedReturn)(anchor);
}
