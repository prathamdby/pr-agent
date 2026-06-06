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
}));

import { safeReaction } from "../src/agentWork/githubPrSurface.js";

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
});
