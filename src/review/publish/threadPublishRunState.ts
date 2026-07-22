import { fingerprintFinding } from "../findings/reviewFindingFingerprint.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";
import type { ReviewFinding } from "../reviewSchema.js";

/** Shared mutable state across incremental thread batches and the final summary. */
export type ThreadPublishRunState = {
  postedFingerprints: Set<string>;
  postedInlineCount: number;
  /**
   * Judgment publish attempts this run (vs `MAX_THREAD_PUBLISH_CALLS`).
   * Counts empty-after-suppression and failed GitHub attempts, not only durable successful batches.
   * After the attempt budget, later findings are summary-only.
   */
  batchCount: number;
  inlineReviewIds: number[];
  acceptedFindings: ReviewFinding[];
  partialSpecialists: string[];
  /** Accumulated placements for the final summary table / summary-only rows. */
  summaryPlacements: InlinePlacement[];
};

export function createThreadPublishRunState(
  overrides: Partial<ThreadPublishRunState> = {},
): ThreadPublishRunState {
  return {
    postedFingerprints: new Set(),
    postedInlineCount: 0,
    batchCount: 0,
    inlineReviewIds: [],
    acceptedFindings: [],
    partialSpecialists: [],
    ...overrides,
    summaryPlacements: overrides.summaryPlacements ?? [],
  };
}

/** Deduped append of accepted findings (fingerprint under mode `"review"`). */
export function appendAcceptedFindings(
  runState: ThreadPublishRunState,
  findings: readonly ReviewFinding[],
): void {
  const existing = new Set(
    runState.acceptedFindings.map((finding) => fingerprintFinding(finding, "review")),
  );
  for (const finding of findings) {
    const fingerprint = fingerprintFinding(finding, "review");
    if (existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    runState.acceptedFindings.push(finding);
  }
}

export function appendSummaryPlacements(
  runState: ThreadPublishRunState,
  placements: readonly InlinePlacement[],
): void {
  runState.summaryPlacements.push(...placements);
}
