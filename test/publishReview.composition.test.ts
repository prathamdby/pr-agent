import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadPublishRunState } from "../src/review/publish/publishFindingBatch.js";
import { createSubmitReviewState } from "../src/review/publish/submitReviewTool.js";
import { fingerprintFinding } from "../src/review/findings/reviewFindingFingerprint.js";
import { prepareReviewPayloadForPublish } from "../src/review/findings/findingPipeline.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";
import {
  publishReviewTestBaseParams,
  publishReviewTestPayload,
} from "./helpers/publishReviewTestSetup.js";

vi.mock("../src/review/publish/publishFindingBatch.js", () => ({
  publishFindingBatch: vi.fn(
    async (
      batch: typeof publishReviewTestPayload.findings,
      context: { runState: ThreadPublishRunState },
    ) => {
      context.runState.acceptedFindings.push(...batch);
      context.runState.inlineReviewIds.push(42);
      context.runState.postedInlineCount += batch.length;
      context.runState.summaryPlacements = batch.map((finding) => ({
        finding,
        inlineLine: finding.startLine,
        inlinePosted: true,
      }));
      return {
        kind: "published" as const,
        reviewId: 42,
        posted: batch.length,
        suppressed: 0,
        dropped: 0,
      };
    },
  ),
}));

vi.mock("../src/review/publish/publishSummaryOnly.js", () => ({
  publishReviewSummaryOnly: vi.fn(async () => ({ summaryCommentId: 2 })),
}));

import { publishFindingBatch } from "../src/review/publish/publishFindingBatch.js";
import { publishReview } from "../src/review/publish/publishReview.js";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.js";

describe("publishReview V1 composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("composes one finding batch and one summary-only publish with resumed review ids", async () => {
    const cachedDiffIndex = cachedDiffForLines("src/x.ts", [4]);
    const prepared = prepareReviewPayloadForPublish({
      payload: publishReviewTestPayload,
      mode: "review",
      cachedDiffIndex,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const storedFingerprint = fingerprintFinding(
      { ...publishReviewTestPayload.findings[0], title: "Stored finding" },
      "review",
    );
    const publishState = createSubmitReviewState({
      inlineReviewIds: [41],
      postedInlineCount: 3,
    });
    const recordPublishStep = vi.fn(async () => undefined);

    await publishReview({
      ...publishReviewTestBaseParams,
      publishState,
      cachedDiffIndex,
      inlinePlacements: prepared.prepared.placements,
      storedInlineFingerprints: [storedFingerprint],
      recordPublishStep,
    });

    expect(publishFindingBatch).toHaveBeenCalledTimes(1);
    const batchContext = vi.mocked(publishFindingBatch).mock.calls[0]?.[1];
    expect(batchContext?.runState.postedFingerprints).toContain(storedFingerprint);
    // Seeded from publishState (3) then the mock posts the batch findings (+1).
    expect(batchContext?.runState.postedInlineCount).toBe(4);
    expect(batchContext?.runState.inlineReviewIds).toEqual([41, 42]);
    expect(publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: prepared.prepared.payload,
        inlineReviewIds: [41, 42],
        recordPublishStep,
      }),
    );
    expect(publishState.inlineReviewIds).toEqual([41, 42]);
  });
});
