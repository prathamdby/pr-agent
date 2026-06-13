import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { executeAckJob } from "../src/agentWork/executors/ackExecutor.js";
import type { AckJobData } from "../src/agentWork/types.js";

vi.mock("../src/agentWork/durableJob.js", () => ({
  mintInstallationToken: vi.fn(async () => ({
    token: "tok",
    expiresAtTs: Date.now() + 3_600_000,
    ttlMs: 3_600_000,
  })),
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getAppBotIdentity: vi.fn(),
  getPullRequestHeadSha: vi.fn(),
  postAckReply: vi.fn(),
  safeReaction: vi.fn(),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  recordPublishStep: vi.fn(),
  claimSummaryCommentCreation: vi.fn(async () => true),
}));

vi.mock("../src/review/publish/publishReview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/publish/publishReview.js")>();
  return {
    ...actual,
    upsertSummaryCommentWithCreationClaim: vi.fn(async () => ({ id: 42, updated: false })),
  };
});

import { safeReaction } from "../src/agentWork/githubPrSurface.js";
import { upsertSummaryCommentWithCreationClaim } from "../src/review/publish/publishReview.js";
import { recordPublishStep } from "../src/agentWork/repository.js";

const cfg = {} as Config;
const pool = {} as Pool;

function ackData(): AckJobData {
  return {
    kind: "ack",
    installationId: 42,
    owner: "o",
    repo: "r",
    prNumber: 1,
    targets: [
      { kind: "pr", prNumber: 1 },
      { kind: "issueComment", commentId: 10 },
      { kind: "reviewComment", commentId: 20 },
    ],
  };
}

describe("executeAckJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reacts to every target even when one reaction fails", async () => {
    vi.mocked(safeReaction)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("reaction failed"))
      .mockResolvedValueOnce(undefined);

    await expect(executeAckJob(cfg, pool, ackData())).resolves.toBeUndefined();

    expect(safeReaction).toHaveBeenCalledTimes(3);
    expect(vi.mocked(safeReaction).mock.calls.map((call) => call[3])).toEqual(ackData().targets);
  });

  it("uses coordinated summary upsert for progress with work item id", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
      }),
    );
    expect(recordPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        step: "progress_comment",
        githubId: 42,
      }),
    );
  });
});
