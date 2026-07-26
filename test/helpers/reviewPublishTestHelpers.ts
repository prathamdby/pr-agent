import { publishReview } from "../../src/review/publish/publishReview.js";
import { prepareReviewPayloadForPublish } from "../../src/review/findings/findingPipeline.js";
import type { EvidenceLedger } from "../../src/review/findings/evidenceLedger.js";
import type { InlinePlacement } from "../../src/review/placement/reviewDiffPlacement.js";
import type { ReviewFinding } from "../../src/review/reviewSchema.js";
import type { AnyReviewLens } from "../../src/settings/legacyReviewLenses.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "../../src/review/placement/reviewDiffIndex.js";
import { createSubmitReviewState } from "../../src/review/publish/submitReviewTool.js";
import { createTestEvidenceLedger, seedEvidenceForFindings } from "./evidenceTestHelpers.js";

/** Runs pre-publish pipeline then publishReview (matches submitReview path). */
export async function publishReviewForTest(
  params: Parameters<typeof publishReview>[0] & {
    mode?: AnyReviewLens;
    evidenceLedger?: EvidenceLedger;
    headSha?: string;
  },
): Promise<void> {
  const headSha = params.headSha ?? "sha";
  const evidenceLedger = params.evidenceLedger ?? createTestEvidenceLedger(headSha);
  seedEvidenceForFindings(evidenceLedger, params.payload.findings);
  const prepared = prepareReviewPayloadForPublish({
    payload: params.payload,
    cachedDiffIndex: params.cachedDiffIndex,
    evidenceLedger,
    headSha,
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
  }));
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
