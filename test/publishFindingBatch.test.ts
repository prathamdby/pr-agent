import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import {
  publishFindingBatch,
  type ThreadPublishRunState,
} from "../src/review/publish/publishFindingBatch.js";
import { fingerprintFinding } from "../src/review/findings/reviewFindingFingerprint.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { MAX_INLINE_REVIEW_COMMENTS, MAX_THREAD_PUBLISH_CALLS } from "../src/settings/index.js";
import { cachedDiffForFiles, cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  const { createReviewPublishGithubMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewPublishGithubMock(actual);
});

import { createPullRequestReviewWithComments } from "../src/github/reviewPublish.js";

const finding: ReviewFinding = {
  severity: "P1",
  file: "src/x.ts",
  startLine: 4,
  endLine: 4,
  title: "Batch bug",
  detail: "The batch exposes a correctness bug.",
  fixPrompt: "Fix the batch bug.",
};

function runState(overrides: Partial<ThreadPublishRunState> = {}): ThreadPublishRunState {
  return {
    postedFingerprints: new Set(),
    postedInlineCount: 0,
    batchCount: 0,
    inlineReviewIds: [],
    acceptedFindings: [],
    partialSpecialists: [],
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      hasDescriptionAgentBlock: false,
    },
    getToken: () => "t",
    cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    recordPublishStep: vi.fn(async () => undefined),
    shouldAbortPublish: async () => false,
    runState: runState(),
    ...overrides,
  };
}

describe("publishFindingBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes one durable COMMENT batch and updates run state", async () => {
    const ctx = context();

    await expect(publishFindingBatch([finding], ctx)).resolves.toEqual({
      kind: "published",
      reviewId: 1,
      posted: 1,
      suppressed: 0,
      dropped: 0,
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "COMMENT",
        comments: [expect.objectContaining({ path: "src/x.ts", line: 4 })],
      }),
      undefined,
    );
    expect(ctx.recordPublishStep).toHaveBeenCalledWith("inline_review", {
      githubId: 1,
      meta: {
        batches: [
          expect.objectContaining({
            reviewId: 1,
            event: "COMMENT",
            url: "https://example.com/review/1",
            counts: { posted: 1, suppressed: 0, dropped: 0 },
          }),
        ],
      },
    });
    expect(ctx.runState.postedInlineCount).toBe(1);
    expect(ctx.runState.batchCount).toBe(1);
    expect(ctx.runState.inlineReviewIds).toEqual([1]);
    expect(ctx.runState.acceptedFindings).toEqual([finding]);
  });

  it("suppresses an exact duplicate in a second batch without creating another review", async () => {
    const ctx = context();

    await publishFindingBatch([finding], ctx);
    await expect(publishFindingBatch([finding], ctx)).resolves.toEqual({ kind: "empty" });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    expect(ctx.runState.batchCount).toBe(2);
    expect(ctx.runState.acceptedFindings).toEqual([finding]);
  });

  it("suppresses a stored fingerprint from an adjacent line bucket before review creation", async () => {
    const adjacentFinding = {
      ...finding,
      startLine: 50,
      endLine: 50,
    };
    const ctx = context({
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [50]),
      runState: runState({
        postedFingerprints: new Set([fingerprintFinding(finding, "review")]),
      }),
    });

    await expect(publishFindingBatch([adjacentFinding], ctx)).resolves.toEqual({ kind: "empty" });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(ctx.runState.acceptedFindings).toEqual([adjacentFinding]);
  });

  it("applies the inline cap globally and retains overflow as summary-only findings", async () => {
    const findings = Array.from(
      { length: 4 },
      (_, index): ReviewFinding => ({
        ...finding,
        file: `src/${index}.ts`,
        startLine: index + 1,
        endLine: index + 1,
        title: `Bug ${index}`,
        detail: `Bug detail ${index}`,
      }),
    );
    const ctx = context({
      cachedDiffIndex: cachedDiffForFiles(
        findings.map((item) => ({ file: item.file, lines: [item.startLine] })),
      ),
      runState: runState({ postedInlineCount: MAX_INLINE_REVIEW_COMMENTS - 1 }),
    });

    await expect(publishFindingBatch(findings, ctx)).resolves.toEqual({
      kind: "published",
      reviewId: 1,
      posted: 1,
      suppressed: 0,
      dropped: 3,
    });

    const request = vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[4];
    expect(request?.comments).toHaveLength(1);
    expect(ctx.runState.postedInlineCount).toBe(MAX_INLINE_REVIEW_COMMENTS);
    expect(ctx.runState.acceptedFindings).toHaveLength(4);
  });

  it.each([
    { staleHead: true, expected: "stale_head" as const },
    { staleHead: false, expected: "superseded" as const },
  ])("aborts a $expected batch before creating a review", async ({ staleHead, expected }) => {
    const ctx = context({
      shouldAbortPublish: async () => true,
      publishAbortState: { staleHead },
    });

    await expect(publishFindingBatch([finding], ctx)).resolves.toEqual({
      kind: "aborted",
      reason: expected,
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(ctx.runState.acceptedFindings).toEqual([]);
    expect(ctx.runState.batchCount).toBe(0);
  });

  it("treats an abort-check failure as superseded", async () => {
    const ctx = context({
      shouldAbortPublish: async () => {
        throw new Error("database unavailable");
      },
    });

    await expect(publishFindingBatch([finding], ctx)).resolves.toEqual({
      kind: "aborted",
      reason: "superseded",
    });
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });

  it("retains the exhausted batch and every later batch as accepted summary-only findings", async () => {
    const laterFinding: ReviewFinding = {
      ...finding,
      file: "src/later.ts",
      title: "Later bug",
      detail: "This later bug must remain in the summary.",
    };
    const ctx = context({
      runState: runState({ batchCount: MAX_THREAD_PUBLISH_CALLS }),
      cachedDiffIndex: cachedDiffForFiles([
        { file: finding.file, lines: [finding.startLine] },
        { file: laterFinding.file, lines: [laterFinding.startLine] },
      ]),
    });

    await expect(publishFindingBatch([finding], ctx)).resolves.toEqual({
      kind: "budget_exhausted",
    });
    await expect(publishFindingBatch([laterFinding], ctx)).resolves.toEqual({
      kind: "budget_exhausted",
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(ctx.runState.acceptedFindings).toEqual([finding, laterFinding]);
    expect(ctx.runState.postedInlineCount).toBe(0);
  });

  it("validates anchors before creating a review", async () => {
    const ctx = context({
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [1]),
    });

    await expect(publishFindingBatch([finding], ctx)).rejects.toThrow(
      /Inline anchor validation failed/,
    );
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });

  it("downgrades to summary-only when GitHub rejects the review for a non-line error", async () => {
    vi.mocked(createPullRequestReviewWithComments).mockRejectedValueOnce(
      new Error("GitHub API unavailable"),
    );
    const ctx = context();

    await expect(publishFindingBatch([finding], ctx)).resolves.toEqual({ kind: "empty" });

    expect(ctx.runState.acceptedFindings).toEqual([finding]);
    expect(ctx.runState.summaryPlacements).toEqual([
      expect.objectContaining({
        finding,
        inlinePosted: false,
      }),
    ]);
    expect(ctx.runState.inlineReviewIds).toEqual([]);
    expect(ctx.recordPublishStep).not.toHaveBeenCalled();
  });

  it("propagates durable record failures after a successful GitHub review post", async () => {
    const ctx = context({
      recordPublishStep: vi.fn(async () => {
        throw new Error("publish_records upsert failed");
      }),
    });

    await expect(publishFindingBatch([finding], ctx)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("review.finding_batch_record_failed");
      expect((error as AppError).cause).toBeInstanceOf(Error);
      expect(String(((error as AppError).cause as Error).message)).toMatch(
        /publish_records upsert failed/,
      );
      return true;
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalled();
    expect(ctx.runState.inlineReviewIds).toEqual([]);
    expect(ctx.runState.postedInlineCount).toBe(0);
  });

  it("propagates durable record failures after a successful repeat-no-bugs review post", async () => {
    const ctx = context({
      shouldLinkToSummary: true,
      summaryCommentUrl: "https://github.com/o/r/pull/1#issuecomment-7",
      recordPublishStep: vi.fn(async () => {
        throw new Error("publish_records upsert failed");
      }),
    });

    await expect(publishFindingBatch([], ctx)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("review.finding_batch_record_failed");
      expect((error as AppError).cause).toBeInstanceOf(Error);
      expect(String(((error as AppError).cause as Error).message)).toMatch(
        /publish_records upsert failed/,
      );
      return true;
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    expect(ctx.runState.inlineReviewIds).toEqual([]);
  });
});
