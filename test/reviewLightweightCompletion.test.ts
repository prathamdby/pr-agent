import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 42, updated: true })),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  shouldSkipWork: vi.fn(),
  recordPublishStep: vi.fn(async () => undefined),
}));

import { upsertReviewSummaryComment } from "../src/github/reviewPublish.js";
import { recordPublishStep, shouldSkipWork } from "../src/agentWork/repository.js";

const pool = {} as Pool;

function autoReviewItem(): AgentWorkItem {
  return {
    id: "wi-1",
    webhookEventId: "ev-1",
    type: "review",
    source: "auto",
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "sha",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 1,
    payload: { mode: "review", source: "auto" },
    cancelRequestedAt: new Date(),
  };
}

describe("tryLightweightAutoReviewCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldSkipWork).mockResolvedValue(false);
  });

  it("does not publish summary when shouldSkipWork is true", async () => {
    vi.mocked(shouldSkipWork).mockResolvedValue(true);

    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      token: "tok",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toEqual({
      handled: true,
      published: false,
      reason: "skipped",
    });
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("publishes summary when trivial and work is not skipped", async () => {
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      token: "tok",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toEqual({ handled: true, published: true, summaryId: 42 });
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(recordPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ step: "summary_comment", githubId: 42 }),
    );
  });
});
