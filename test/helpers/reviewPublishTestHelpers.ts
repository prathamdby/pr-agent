import type { InlinePlacement } from "../../src/agent/reviewLocationValidation.js";
import { planInlinePlacements } from "../../src/agent/reviewLocationValidation.js";
import type { ReviewFinding, ReviewPayload } from "../../src/agent/reviewSchema.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "../../src/agent/reviewDiffIndex.js";
import { createSubmitReviewState } from "../../src/agent/submitReviewTool.js";

export function testPublishState(
  overrides: Partial<ReturnType<typeof createSubmitReviewState>> = {},
) {
  return { ...createSubmitReviewState(), ...overrides };
}

export function testPlacements(
  findings: ReviewFinding[],
  opts: { inlinePosted?: boolean; inlineLine?: number | null } = {},
): InlinePlacement[] {
  const inlinePosted = opts.inlinePosted ?? true;
  return findings.map((finding) => ({
    finding,
    inlineLine: inlinePosted ? (opts.inlineLine ?? finding.startLine) : null,
    inlinePosted,
    inlineCapEligible: inlinePosted,
  }));
}

export function planInlineFromPayload(
  payload: ReviewPayload,
  maxFindings = 8,
  diffIndex?: CachedPrDiffIndex,
): InlinePlacement[] {
  return planInlinePlacements(payload.findings, maxFindings, diffIndex);
}

export function testPlacementsFromPayload(
  payload: ReviewPayload,
  inlinePosted = true,
): InlinePlacement[] {
  return testPlacements(payload.findings, { inlinePosted });
}

export function cachedDiffForLines(
  file: string,
  lines: number[],
  patch = buildPatchForRightLines(lines),
): CachedPrDiffIndex {
  const index = createCachedPrDiffIndex();
  ingestListPullRequestFilesResult(index, {
    files: [{ filename: file, patch }],
  });
  return index;
}

export function cachedDiffForFiles(
  entries: Array<{ file: string; lines: number[] }>,
): CachedPrDiffIndex {
  const index = createCachedPrDiffIndex();
  for (const entry of entries) {
    ingestListPullRequestFilesResult(index, {
      files: [{ filename: entry.file, patch: buildPatchForRightLines(entry.lines) }],
    });
  }
  return index;
}

function buildPatchForRightLines(lines: number[]): string {
  const start = Math.min(...lines);
  const end = Math.max(...lines);
  const hunkLines: string[] = [];
  for (let line = start; line <= end; line++) {
    hunkLines.push(lines.includes(line) ? `+code at line ${line}` : ` context at line ${line}`);
  }
  return `@@ -${start},1 +${start},${hunkLines.length} @@\n${hunkLines.join("\n")}`;
}
