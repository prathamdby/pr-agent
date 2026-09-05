import type { Config } from "../../src/config.js";
import { reviewCheckDetailsUrl } from "../../src/agentWork/reviewCheckRun.js";
import type { AnyReviewLens } from "../../src/settings/legacyReviewLenses.js";
import type { PrSurface } from "../../src/github/prSurface.js";
import {
  createCachedPrDiffIndex,
  ingestListPullRequestFilesResult,
  type CachedPrDiffIndex,
} from "../../src/review/placement/reviewDiffIndex.js";
import type { AcceptedPlacement } from "../../src/review/orchestrator/orchestratorTypes.js";
import {
  applyFindingLedgerDelta,
  createFindingLedger,
} from "../../src/review/orchestrator/orchestratorTypes.js";
import type { CiSummaryAuthor } from "../../src/review/ci/authorCiSummary.js";
import type { ReviewPayload, ReviewPublishContext } from "../../src/review/reviewSchema.js";
import type { RepoPolicyResult } from "../../src/review/repoPolicy.js";
import type { BoundPolicyJudge } from "../../src/review/publish/boundPolicyJudge.js";
import { publishFindingBatch } from "../../src/review/publish/publishFindingBatch.js";
import { publishReviewSummaryOnly } from "../../src/review/publish/publishSummaryOnly.js";
import type { RecordPublishStepWithCoordination } from "../../src/review/publish/summaryCommentUpsert.js";
import { prepareReviewPayloadForPublish } from "../../src/review/findings/findingPipeline.js";
import type { EvidenceLedger } from "../../src/review/findings/evidenceLedger.js";
import type { InlinePlacement } from "../../src/review/placement/reviewDiffPlacement.js";
import type { ReviewFinding } from "../../src/review/reviewSchema.js";
import { createTestEvidenceLedger, seedEvidenceForFindings } from "./evidenceTestHelpers.js";

export type PublishTestState = {
  inlineReviewIds: number[];
  threadCallCount: number;
  /** Set when publish is skipped (superseded, cancelled, or abort-check failed). */
  publishSuperseded: boolean;
};

export function createPublishTestState(initial?: {
  readonly inlineReviewIds?: readonly number[];
  readonly threadCallCount?: number;
}): PublishTestState {
  return {
    inlineReviewIds: [...(initial?.inlineReviewIds ?? [])],
    threadCallCount: initial?.threadCallCount ?? 0,
    publishSuperseded: false,
  };
}

/**
 * Test-only composer mirroring the orchestrated tool order (finding batch,
 * then summary) through the live production functions. Validation,
 * redaction, and rendering all execute inside publishFindingBatch and
 * publishReviewSummaryOnly, so keep this order in sync with the orchestrator
 * tools when that order changes.
 */
export async function runTestPublishFlow(
  params: ReviewPublishContext & {
    prSurface: PrSurface;
    mode?: AnyReviewLens;
    cfg: Pick<Config, "piModel" | "features">;
    payload: ReviewPayload;
    dedupedFindingCount?: number;
    publishState: PublishTestState;
    cachedDiffIndex?: CachedPrDiffIndex;
    shouldLinkToSummary?: boolean;
    progressCommentIdHint?: number | null;
    staleReview?: boolean;
    recordPublishStep?: RecordPublishStepWithCoordination;
    storedInlineFingerprints?: readonly string[];
    ciSummaryAuthor?: CiSummaryAuthor;
    workItemId?: string;
    resumedPlacements?: readonly AcceptedPlacement[];
    shouldAbortPublish?: () => Promise<boolean>;
    publishAbortState?: { readonly staleHead?: boolean };
    repoPolicy?: RepoPolicyResult;
    sameRepo?: boolean;
    boundPolicyJudge?: BoundPolicyJudge;
    readCheckoutFile?: (path: string) => Promise<string | undefined>;
  },
): Promise<void> {
  const resumedPlacements = params.resumedPlacements ?? [];
  let ledger = createFindingLedger({
    accepted: resumedPlacements,
    suppressionFingerprints: params.storedInlineFingerprints,
    inlineReviewIds: params.publishState.inlineReviewIds,
    postedInlineCount: resumedPlacements.length,
    threadCallCount: params.publishState.threadCallCount,
  });
  const batchResult = await publishFindingBatch(params.payload.findings, {
    ctx: params,
    source: "review",
    workItemId:
      params.workItemId ?? params.recordPublishStep?.summaryCommentCoordination?.workItemId,
    operationIntent: params.recordPublishStep?.summaryCommentCoordination
      ? {
          client: params.recordPublishStep.summaryCommentCoordination.pool,
          workItemId: params.recordPublishStep.summaryCommentCoordination.workItemId,
          resourceKey: params.recordPublishStep.summaryCommentCoordination.resourceKey,
          leaseEpoch: params.recordPublishStep.summaryCommentCoordination.leaseEpoch,
        }
      : undefined,
    resolveProgressCommentUrl: async () =>
      reviewCheckDetailsUrl(
        params.owner,
        params.repo,
        params.prNumber,
        params.progressCommentIdHint,
      ),
    prSurface: params.prSurface,
    cachedDiffIndex: params.cachedDiffIndex ?? createCachedPrDiffIndex(),
    recordPublishStep: params.recordPublishStep,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    repoPolicy: params.repoPolicy,
    sameRepo: params.sameRepo,
    boundPolicyJudge: params.boundPolicyJudge,
    readCheckoutFile: params.readCheckoutFile,
    ledger,
  });
  if (batchResult.kind === "stopped") {
    params.publishState.publishSuperseded = true;
    return;
  }

  ledger = applyFindingLedgerDelta(ledger, batchResult.delta);
  params.publishState.inlineReviewIds = [...ledger.inlineReviewIds];
  params.publishState.threadCallCount = ledger.threadCallCount;

  const summaryResult = await publishReviewSummaryOnly({
    cfg: params.cfg,
    ctx: params,
    prSurface: params.prSurface,
    payload: params.payload,
    ledger,
    mode: params.mode,
    cachedDiffIndex: params.cachedDiffIndex,
    shouldLinkToSummary: params.shouldLinkToSummary,
    progressCommentIdHint: params.progressCommentIdHint,
    staleReview: params.staleReview,
    recordPublishStep: params.recordPublishStep,
    ciAuthor: params.ciSummaryAuthor,
    shouldAbortPublish: params.shouldAbortPublish,
    publishAbortState: params.publishAbortState,
    dedupedFindingCount: params.dedupedFindingCount,
  });
  if (summaryResult.kind === "stopped") {
    params.publishState.publishSuperseded = true;
  }
}

/** Runs pre-publish pipeline then the test publish flow (legacy test harness). */
export async function publishReviewForTest(
  params: Parameters<typeof runTestPublishFlow>[0] & {
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
  await runTestPublishFlow({
    ...params,
    payload: prepared.prepared.payload,
    dedupedFindingCount: prepared.prepared.dedupedCount,
  });
}

export function testPublishState(
  overrides: Partial<ReturnType<typeof createPublishTestState>> = {},
) {
  return { ...createPublishTestState(), ...overrides };
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
