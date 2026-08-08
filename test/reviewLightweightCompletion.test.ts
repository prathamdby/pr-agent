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

vi.mock("../src/review/run/reviewRunMetrics.js", () => ({
  snapshotReviewRunMetrics: vi.fn(() => null),
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
import { snapshotReviewRunMetrics } from "../src/review/run/reviewRunMetrics.js";

const pool = {} as Pool;

function autoReviewItem(overrides: { headSha?: string } = {}): AgentWorkItem {
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
    headSha: overrides.headSha ?? "sha",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 1,
    executionEpoch: 1,
    payload: { mode: "review", source: "auto" },
    cancelRequestedAt: new Date(),
  };
}

describe("tryLightweightAutoReviewCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldSkipWork).mockResolvedValue(false);
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue(null);
  });

  it("does not publish summary when shouldSkipWork is true", async () => {
    vi.mocked(shouldSkipWork).mockResolvedValue(true);

    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      token: "tok",
      model: "grok-4.5",
      executionEpoch: 1,
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
      executionEpoch: 1,
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

  it("publishes a 0s footer when metrics snapshot is null", async () => {
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      token: "tok",
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toEqual({ handled: true, published: true, summaryId: 42 });
    expect(snapshotReviewRunMetrics).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      1,
      expect.stringContaining("<sub>abc123d ⋅ general ⋅ 0s ⋅ grok-4.5</sub>"),
      expect.any(String),
      undefined,
      undefined,
    );
  });

  it("uses worker-start metrics for the footer duration and ignores stub post time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:10:00.000Z"));
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue({
      startedAtMs: Date.parse("2026-07-22T12:08:00.000Z"),
    } as ReturnType<typeof snapshotReviewRunMetrics>);

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      token: "tok",
      model: "grok-4.5",
      executionEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      1,
      expect.stringContaining("<sub>abc123d ⋅ general ⋅ 2m ⋅ grok-4.5</sub>"),
      expect.any(String),
      undefined,
      undefined,
    );
    vi.useRealTimers();
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
      executionEpoch: 1,
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
