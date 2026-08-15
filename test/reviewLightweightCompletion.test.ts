import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getSummaryCommentGithubId: vi.fn(async () => null),
  shouldSkipWork: vi.fn(),
  recordPublishStep: vi.fn(async () => undefined),
}));

vi.mock("../src/review/run/reviewRunMetrics.js", () => ({
  snapshotReviewRunMetrics: vi.fn(() => null),
}));

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
    payload: { mode: "review", source: "auto" },
    cancelRequestedAt: new Date(),
  };
}

function fakeSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
}

describe("tryLightweightAutoReviewCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldSkipWork).mockResolvedValue(false);
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue(null);
  });

  it("does not publish summary when shouldSkipWork is true", async () => {
    vi.mocked(shouldSkipWork).mockResolvedValue(true);
    const { surface, controls } = fakeSurface();

    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: 1,
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
    expect(controls.events.filter((event) => event.kind === "upsertProgressComment")).toHaveLength(
      0,
    );
    expect(recordPublishStep).not.toHaveBeenCalled();
  });

  it("publishes summary when trivial and work is not skipped", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true });
    expect(controls.events.some((event) => event.kind === "upsertProgressComment")).toBe(true);
    expect(recordPublishStep).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ step: "summary_comment" }),
    );
  });

  it("publishes a 0s footer when metrics snapshot is null", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true });
    expect(snapshotReviewRunMetrics).toHaveBeenCalled();
    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 0s ⋅ grok-4.5</sub>",
    );
  });

  it("uses worker-start metrics for the footer duration and ignores stub post time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:10:00.000Z"));
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue({
      startedAtMs: Date.parse("2026-07-22T12:08:00.000Z"),
    } as ReturnType<typeof snapshotReviewRunMetrics>);
    const { surface, controls } = fakeSurface();

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 2m ⋅ grok-4.5</sub>",
    );
    vi.useRealTimers();
  });

  it("uses stored summary id when resolving the progress comment", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    const { surface, controls } = fakeSurface();
    controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "existing", 55);

    await tryLightweightAutoReviewCompletion(pool, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      leaseEpoch: 1,
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(getSummaryCommentGithubId).toHaveBeenCalledWith(pool, "o/r#1", "review");
    const resolve = controls.events.find((event) => event.kind === "resolveProgressComment");
    expect(resolve).toMatchObject({
      kind: "resolveProgressComment",
      hintCommentId: 55,
    });
    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.knownExisting).toMatchObject({
      id: 55,
    });
  });
});
