import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/review/publish/publishReview.js", () => ({
  upsertSummaryCommentWithCreationClaim: vi.fn(async () => ({
    id: 42,
    updated: true,
  })),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

import { logWarn } from "../src/evlog.js";
import { tickProgressComment } from "../src/review/orchestrator/stubTick.js";
import { upsertSummaryCommentWithCreationClaim } from "../src/review/publish/publishReview.js";

const pool = {} as Pool;

function specialistTickArgs() {
  return {
    pool,
    workItemId: "wi-1",
    resourceKey: "o/r#1",
    owner: "o",
    repo: "r",
    prNumber: 1,
    mode: "review" as const,
    headSha: "a".repeat(40),
    source: "auto" as const,
    progressRevision: 2 as const,
    tickState: {
      kind: "specialists" as const,
      recon: "done" as const,
      specialists: {
        correctness: { phase: "done" as const, threadsPublished: 0 },
        security: { phase: "running" as const },
        quality: { phase: "running" as const },
        tests: { phase: "running" as const },
      },
    },
  };
}

describe("tickProgressComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the rendered tick with live authentication", async () => {
    const getToken = vi.fn(() => "fresh-token");
    const getTokenExpiresAtTs = vi.fn(() => 123_456);

    await expect(
      tickProgressComment({
        ...specialistTickArgs(),
        getToken,
        getTokenExpiresAtTs,
      }),
    ).resolves.toBeUndefined();

    expect(getToken).toHaveBeenCalledOnce();
    expect(getTokenExpiresAtTs).toHaveBeenCalledOnce();
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        token: "fresh-token",
        expiresAtTs: 123_456,
        progressRevision: 2,
        body: expect.stringContaining("✅ No findings"),
      }),
    );
  });

  it("logs and swallows progress write failures", async () => {
    vi.mocked(upsertSummaryCommentWithCreationClaim).mockRejectedValueOnce(
      new Error("GitHub unavailable"),
    );

    await expect(
      tickProgressComment({
        ...specialistTickArgs(),
        getToken: () => "fresh-token",
        getTokenExpiresAtTs: () => 123_456,
      }),
    ).resolves.toBeUndefined();

    expect(logWarn).toHaveBeenCalledWith(
      "review_progress_tick_failed",
      expect.objectContaining({
        owner: "o",
        repo: "r",
        pr: 1,
        progressRevision: 2,
        message: "GitHub unavailable",
      }),
    );
  });
});
