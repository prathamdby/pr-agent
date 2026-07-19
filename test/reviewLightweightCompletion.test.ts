import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  resolveVerifiedSummaryCommentRef: vi.fn(async () => null),
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 42, updated: true })),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getSummaryCommentGithubId: vi.fn(async () => null),
  shouldSkipWork: vi.fn(),
  recordPublishStep: vi.fn(async () => undefined),
}));

import {
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";
import {
  getSummaryCommentGithubId,
  recordPublishStep,
  shouldSkipWork,
} from "../src/agentWork/repository.js";

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
      model: "grok-4.5",
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
      model: "grok-4.5",
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

  it("uses stored summary id without scanning when verified", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 55,
      url: "https://example.com/55",
      source: "hint",
    });

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      token: "tok",
      tokenExpiresAtTs: 1_000_000,
      model: "grok-4.5",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(getSummaryCommentGithubId).toHaveBeenCalledWith(pool, "o/r#1", "review");
    expect(resolveVerifiedSummaryCommentRef).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      1,
      expect.any(String),
      55,
      1_000_000,
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      1,
      expect.any(String),
      expect.any(String),
      { id: 55, url: "https://example.com/55" },
      1_000_000,
    );
  });
});
