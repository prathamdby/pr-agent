import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrSurface } from "../src/github/prSurface.js";

vi.mock("../src/review/publish/summaryCommentUpsert.js", () => ({
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
import { upsertSummaryCommentWithCreationClaim } from "../src/review/publish/summaryCommentUpsert.js";

const pool = {} as Pool;

function specialistTickArgs(
  prSurface = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface,
) {
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
    prSurface,
    tickState: {
      kind: "specialists" as const,
      recon: "done" as const,
      specialists: {
        correctness: { phase: "done" as const, findingsAccepted: 0 },
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

  it("writes the rendered tick through PrSurface", async () => {
    const prSurface = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 }).surface;

    await expect(tickProgressComment(specialistTickArgs(prSurface))).resolves.toBeUndefined();

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        prSurface,
        progressRevision: 2,
        body: expect.stringContaining("✅ No findings"),
      }),
    );
  });

  it("logs and swallows progress write failures", async () => {
    vi.mocked(upsertSummaryCommentWithCreationClaim).mockRejectedValueOnce(
      new Error("GitHub unavailable"),
    );

    await expect(tickProgressComment(specialistTickArgs())).resolves.toBeUndefined();

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
