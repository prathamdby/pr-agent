import { sqliteReviewCoordination } from "./helpers/publishReviewTestSetup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.ts";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.ts";
import {
  createPublishReviewTestHarness,
  publishReviewTestBaseParams,
  publishReviewTestPayload,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.ts";
import { attachSummaryCommentCoordination } from "../src/review/publish/reviewSummaryComment.ts";

const payload = publishReviewTestPayload;
let harness: PublishReviewTestHarness;
let baseParams: ReturnType<typeof publishReviewTestBaseParams>;

describe("publishReview check run completion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    harness.upsertProgressComment.mockResolvedValue({ id: 2, updated: false });
  });

  function coordinatedRecordPublishStep() {
    return attachSummaryCommentCoordination(
      vi.fn(),
      sqliteReviewCoordination({ workItemId: "wi-1", resourceKey: "o/r#1" }),
    );
  }

  it("completes the review check as failure when published findings include P1", async () => {
    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "failure",
        summary: "1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
    );
  });

  it("completes the review check as failure when findings are P2-only", async () => {
    await publishReviewForTest({
      ...baseParams,
      payload: {
        ...payload,
        findings: [{ ...payload.findings[0], severity: "P2" }],
      },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "failure", summary: "1 finding" }),
    );
  });

  it("completes the review check as success when findings are empty", async () => {
    await publishReviewForTest({
      ...baseParams,
      payload: { ...payload, findings: [] },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success", summary: "No findings" }),
    );
  });

  it("completes the review check as success when findings are P3-only", async () => {
    await publishReviewForTest({
      ...baseParams,
      payload: {
        ...payload,
        findings: [
          {
            ...payload.findings[0],
            severity: "P3",
            fixPrompt: "Polish the advisory copy.",
          },
        ],
      },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(harness.surface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success", summary: "No findings" }),
    );
  });
});

describe("publishReview commit status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    harness.upsertProgressComment.mockResolvedValue({ id: 2, updated: false });
  });

  function coordinatedRecordPublishStep() {
    return attachSummaryCommentCoordination(
      vi.fn(),
      sqliteReviewCoordination({ workItemId: "wi-1", resourceKey: "o/r#1" }),
    );
  }

  it("completes publish when commit status API throws", async () => {
    harness.setReviewCommitStatus.mockRejectedValueOnce(new Error("status api down"));

    await expect(
      publishReviewForTest({
        ...baseParams,
        cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
        publishState: testPublishState({ inlineReviewIds: [1] }),
        cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
        recordPublishStep: coordinatedRecordPublishStep(),
      }),
    ).resolves.toBeUndefined();
  });
});
