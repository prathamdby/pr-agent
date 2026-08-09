import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import {
  createPublishReviewTestHarness,
  publishReviewTestBaseParams,
  publishReviewTestPayload,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.js";

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/reviewCheckRun.js", async () => {
  const { createReviewCheckRunMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewCheckRunMock();
});

import { attachSummaryCommentCoordination } from "../src/review/publish/publishReview.js";
import { completeReviewCheckRun } from "../src/agentWork/reviewCheckRun.js";

const payload = publishReviewTestPayload;
let harness: PublishReviewTestHarness;
let baseParams: ReturnType<typeof publishReviewTestBaseParams>;
const pool = {
  connect: vi.fn(async () => ({
    query: vi.fn(async () => undefined),
    release: vi.fn(),
  })),
} as unknown as import("pg").Pool;

describe("publishReview check run completion", () => {
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    harness.upsertProgressComment.mockResolvedValue({ id: 2, updated: false });
  });

  function coordinatedRecordPublishStep() {
    return attachSummaryCommentCoordination(vi.fn(), {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
  }

  it("completes the review check as failure when published findings include P1", async () => {
    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: coordinatedRecordPublishStep(),
    });

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        prSurface: harness.surface,
        owner: "o",
        repo: "r",
        prNumber: 1,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
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

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "failure",
        summary: "1 finding",
      }),
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

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "No findings",
      }),
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

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "No findings",
      }),
    );
  });
});

describe("publishReview commit status", () => {
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
    harness.upsertProgressComment.mockResolvedValue({ id: 2, updated: false });
  });

  it("posts failure when published findings include P1", async () => {
    await publishReviewForTest({
      ...baseParams,
      cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(harness.setReviewCommitStatus).toHaveBeenCalledWith("sha", {
      state: "failure",
      description: "1 finding",
      targetUrl: "https://github.com/o/r/pull/1#issuecomment-2",
    });
  });

  it("posts failure when findings are P2-only", async () => {
    const p2Payload: ReviewPayload = {
      ...payload,
      findings: [
        {
          severity: "P2",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Nit",
          detail: "Minor.",
          fixPrompt: "Fix src/x.ts line 4.",
        },
      ],
    };

    await publishReviewForTest({
      ...baseParams,
      cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
      payload: p2Payload,
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(harness.setReviewCommitStatus).toHaveBeenCalledWith("sha", {
      state: "failure",
      description: "1 finding",
      targetUrl: "https://github.com/o/r/pull/1#issuecomment-2",
    });
  });

  it("completes publish when commit status API throws", async () => {
    harness.setReviewCommitStatus.mockRejectedValueOnce(new Error("status api down"));

    await expect(
      publishReviewForTest({
        ...baseParams,
        cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
        publishState: testPublishState({ inlineReviewIds: [1] }),
        cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      }),
    ).resolves.toBeUndefined();
  });

  it("skips commit status when flag is off", async () => {
    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState({ inlineReviewIds: [1] }),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(harness.setReviewCommitStatus).not.toHaveBeenCalled();
  });
});
