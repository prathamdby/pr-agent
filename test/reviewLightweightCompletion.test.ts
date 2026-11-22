import { sqliteReviewCoordination } from "./helpers/publishReviewTestSetup.ts";
vi.mock("../src/review/findingIdentity/threadMutationLock.ts", () => ({
  threadMutationLock: () => (apply: () => Promise<unknown>) => apply(),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryLightweightAutoReviewCompletion } from "../src/agentWork/reviewLightweightCompletion.ts";
import type { AgentWorkItem } from "../src/agentWork/types.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import { LIGHTWEIGHT_REVIEW_COMPLETION_LEAD } from "../src/settings/index.ts";
import { writePublishStep, workPublishRecord } from "../src/state/publish.ts";

vi.mock("../src/review/run/reviewRunMetrics.ts", () => ({
  snapshotReviewRunMetrics: vi.fn(() => null),
}));

const summaryWrite = vi.hoisted(() =>
  vi.fn(
    async (params: {
      readonly prSurface: import("../src/github/prSurface.ts").PrSurface;
      readonly body: string;
      readonly hintCommentId?: number | null;
      readonly [key: string]: unknown;
    }) =>
      params.prSurface.upsertProgressComment(
        params.body,
        "## PR Agent Review",
        params.hintCommentId != null
          ? { id: params.hintCommentId, url: "https://example.com/c" }
          : null,
      ),
  ),
);

vi.mock("../src/review/publish/reviewSummaryComment.ts", () => ({
  createReviewSummaryComment: (deps: {
    readonly prSurface: import("../src/github/prSurface.ts").PrSurface;
    readonly reviewLens: string;
    readonly coordination?: object;
  }) => ({
    conclude: (write: { readonly body: string; readonly hintCommentId?: number | null }) =>
      summaryWrite({
        prSurface: deps.prSurface,
        reviewLens: deps.reviewLens,
        ...deps.coordination,
        ...write,
        progressRevision: 7,
      }),
  }),
}));

import { snapshotReviewRunMetrics } from "../src/review/run/reviewRunMetrics.ts";

function autoReviewItem(overrides: { headSha?: string } = {}) {
  return ((pinnedReturn: AgentWorkItem) => pinnedReturn)({
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
  });
}

function fakeSurface() {
  return createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
}

let currentWork = true;

describe("tryLightweightAutoReviewCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue(null);
    currentWork = true;
  });

  it("does not publish summary when shouldSkipWork is true", async () => {
    currentWork = false;
    const { surface, controls } = fakeSurface();
    const target = sqliteReviewCoordination();

    const result = await tryLightweightAutoReviewCompletion(target, {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
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
    expect(summaryWrite).not.toHaveBeenCalled();
    expect(workPublishRecord(target.db, target.workItemId, "summary_comment")).toBeUndefined();
  });

  it("writes a terminal lightweight body that replaces the queued stub wording", async () => {
    const { surface, controls } = fakeSurface();
    const target = sqliteReviewCoordination();
    controls.setProgressComment(
      REVIEW_SUMMARY_SENTINEL,
      `${REVIEW_SUMMARY_SENTINEL}\n\n> [!NOTE]\n> Review queued on the latest commit.\n<!-- pr-agent:progress-revision workItemId=wi-1 value=0 -->`,
      99,
    );
    writePublishStep(target.db, {
      workId: target.workItemId,
      prKey: target.resourceKey,
      reviewLens: "review",
      step: "progress_comment",
      githubId: 99,
    });

    const result = await tryLightweightAutoReviewCompletion(target, {
      item: autoReviewItem({ headSha: "5f93e93419cbd32419388cffd90b88804fe6259c" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    expect(result).toMatchObject({ handled: true, published: true, summaryId: 99 });
    const upsertArgs = vi.mocked(summaryWrite).mock.calls[0]?.[0];
    expect(upsertArgs?.progressRevision).toBe(7);
    expect(upsertArgs?.hintCommentId).toBe(99);
    expect(upsertArgs?.body).toContain(LIGHTWEIGHT_REVIEW_COMPLETION_LEAD);
    expect(upsertArgs?.body).not.toContain("Review queued on the latest commit.");
    expect(upsertArgs?.body).toContain("<!-- pr-agent:ci-summary");
    expect(upsertArgs?.body).toContain(
      "<!-- pr-agent:review-meta headSha=5f93e93419cbd32419388cffd90b88804fe6259c lens=review stale=false -->",
    );
  });

  it("publishes a 0s footer when no stub record and metrics snapshot is null", async () => {
    const { surface, controls } = fakeSurface();
    const result = await tryLightweightAutoReviewCompletion(sqliteReviewCoordination(), {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
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

  it("measures the footer duration from the stub post, preferring it over metrics start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:10:00.000Z"));
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue({
      startedAtMs: Date.parse("2026-07-22T12:08:00.000Z"),
    } as ReturnType<typeof snapshotReviewRunMetrics>);
    const { surface, controls } = fakeSurface();
    const target = sqliteReviewCoordination();
    writePublishStep(target.db, {
      workId: target.workItemId,
      prKey: target.resourceKey,
      reviewLens: "review",
      step: "progress_comment",
      githubId: 99,
      detail: { stubPostedAtMs: Date.parse("2026-07-22T12:05:00.000Z") },
    });

    await tryLightweightAutoReviewCompletion(target, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });

    const upsert = controls.events.find((event) => event.kind === "upsertProgressComment");
    expect(upsert?.kind === "upsertProgressComment" && upsert.body).toContain(
      "<sub>abc123d ⋅ general ⋅ 5m ⋅ grok-4.5</sub>",
    );
    vi.useRealTimers();
  });

  it("ignores a stub stamp owned by a different work item", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:10:00.000Z"));
    vi.mocked(snapshotReviewRunMetrics).mockReturnValue({
      startedAtMs: Date.parse("2026-07-22T12:08:00.000Z"),
    } as ReturnType<typeof snapshotReviewRunMetrics>);
    const { surface, controls } = fakeSurface();
    const target = sqliteReviewCoordination();
    writePublishStep(target.db, {
      workId: "wi-foreign",
      prKey: target.resourceKey,
      reviewLens: "review",
      step: "progress_comment",
      githubId: 99,
      detail: { stubPostedAtMs: Date.parse("2026-07-22T12:05:00.000Z") },
    });

    await tryLightweightAutoReviewCompletion(target, {
      item: autoReviewItem({ headSha: "abc123def456" }),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
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

  it("submits an APPROVE review after a published docs-only summary", async () => {
    const { surface } = fakeSurface();
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const result = await tryLightweightAutoReviewCompletion(sqliteReviewCoordination(), {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });
    expect(result).toMatchObject({ handled: true, published: true });
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "APPROVE", commitId: "sha" }),
    );
  });

  it("comments after a lightweight summary when the inventory is incomplete", async () => {
    const { surface, controls } = fakeSurface();
    controls.setThreadResolutionStatus("partial", "thread pagination failed");
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const result = await tryLightweightAutoReviewCompletion(sqliteReviewCoordination(), {
      item: autoReviewItem(),
      reviewLens: "review",
      prSurface: surface,
      model: "grok-4.5",
      isCurrent: () => currentWork,
      checkFailSeverity: "P2",
      preflight: {
        files: [{ filename: "README.md" }],
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
      },
    });
    expect(result).toMatchObject({
      handled: true,
      published: true,
      check: { conclusion: "neutral", blockingCount: 0 },
    });
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({ event: "COMMENT", commitId: "sha" }),
    );
  });
});
