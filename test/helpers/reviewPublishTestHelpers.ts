import { publishReview } from "../../src/agent/publishReview.js";
import { prepareReviewPayloadForPublish } from "../../src/agent/reviewPrePublish.js";
import type { InlinePlacement } from "../../src/agent/reviewDiffPlacement.js";
import { planInlinePlacements } from "../../src/agent/reviewDiffPlacement.js";
import type { ReviewFinding, ReviewMode, ReviewPayload } from "../../src/agent/reviewSchema.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "../../src/agent/reviewDiffIndex.js";
import { createSubmitReviewState } from "../../src/agent/submitReviewTool.js";

/** Runs pre-publish pipeline then publishReview (matches submitReview path). */
export async function publishReviewForTest(
  params: Parameters<typeof publishReview>[0] & { mode?: ReviewMode },
): Promise<void> {
  const mode = params.mode ?? "review";
  const prepared = prepareReviewPayloadForPublish({
    payload: params.payload,
    mode,
    cachedDiffIndex: params.cachedDiffIndex,
    maxInlineFindings: params.cfg.maxReviewFindings,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error);
  }
  await publishReview({
    ...params,
    payload: prepared.prepared.payload,
    dedupedFindingCount: prepared.prepared.dedupedCount,
  });
}

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
  if (lines.length === 0) {
    return "@@ -1,0 +1,0 @@";
  }

  const sorted = [...new Set(lines)].toSorted((a, b) => a - b);
  const runs: number[][] = [];
  let run = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const line = sorted[i];
    const runEnd = run[run.length - 1];
    if (runEnd != null && line === runEnd + 1) {
      run.push(line);
      continue;
    }
    runs.push(run);
    run = [line];
  }
  runs.push(run);

  return runs
    .map((runLines) => {
      const start = runLines[0];
      const hunkLines = runLines.map((line) => `+code at line ${line}`);
      return `@@ -${start},${runLines.length} +${start},${runLines.length} @@\n${hunkLines.join("\n")}`;
    })
    .join("\n");
}
