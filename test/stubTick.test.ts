import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickProgressComment } from "../src/review/orchestrator/stubTick.js";
import { makeTestConfig } from "./helpers/config.js";
import { testTokenHandle } from "./helpers/tokenHandle.js";

const upsertSummaryCommentWithCreationClaim = vi.fn();
const renderReviewProgressComment = vi.fn((_params: unknown) => "## PR Agent Review\n\nstub body");

vi.mock("../src/review/publish/summaryCommentCoordination.js", () => ({
  upsertSummaryCommentWithCreationClaim: (...args: unknown[]) =>
    upsertSummaryCommentWithCreationClaim(...args),
}));

vi.mock("../src/review/run/progressComment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/run/progressComment.js")>();
  return {
    ...actual,
    renderReviewProgressComment: (params: unknown) => renderReviewProgressComment(params),
  };
});

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { logWarn } from "../src/evlog.js";

describe("tickProgressComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertSummaryCommentWithCreationClaim.mockResolvedValue({ id: 5, updated: true });
  });

  it("renders and upserts the progress comment", async () => {
    await tickProgressComment({
      cfg: makeTestConfig(),
      pool: {} as never,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc123",
      source: "slash",
      token: testTokenHandle({ token: "tok" }),
      specialistTicks: {
        correctness: { phase: "done", threadsPublished: 1 },
        security: { phase: "running" },
        quality: { phase: "no_findings" },
        tests: { phase: "failed" },
      },
    });

    expect(renderReviewProgressComment).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "review",
        headSha: "abc123",
        source: "slash",
        specialistTicks: expect.objectContaining({
          correctness: { phase: "done", threadsPublished: 1 },
        }),
      }),
    );
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "tok",
        body: expect.stringContaining("## PR Agent Review"),
        reviewLens: "review",
      }),
    );
  });

  it("refreshes via InstallationTokenHandle before the tick write", async () => {
    let token = "stale";
    const refreshNearExpiry = vi.fn(async () => {
      token = "fresh";
    });

    await tickProgressComment({
      cfg: makeTestConfig(),
      pool: {} as never,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc123",
      source: "auto",
      token: {
        getToken: () => token,
        getExpiresAtTs: () => Date.now() + 3_600_000,
        refreshNearExpiry,
      },
      specialistTicks: {
        correctness: { phase: "running" },
        security: { phase: "running" },
        quality: { phase: "running" },
        tests: { phase: "running" },
      },
    });

    expect(refreshNearExpiry).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({ token: "fresh" }),
    );
  });

  it("soft-fails on upsert errors without throwing", async () => {
    upsertSummaryCommentWithCreationClaim.mockRejectedValueOnce(new Error("github down"));

    await expect(
      tickProgressComment({
        cfg: makeTestConfig(),
        pool: {} as never,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "abc123",
        source: "auto",
        token: testTokenHandle(),
        specialistTicks: {
          correctness: { phase: "running" },
          security: { phase: "running" },
          quality: { phase: "running" },
          tests: { phase: "running" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith(
      "review_stub_tick_failed",
      expect.objectContaining({ owner: "o", repo: "r", pr: 1 }),
    );
  });
});
