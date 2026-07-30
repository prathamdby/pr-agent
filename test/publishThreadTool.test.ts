import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { buildPublishThreadTool } from "../src/review/orchestrator/publishThreadTool.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";

const settingsOverrides = vi.hoisted((): { maxThreadPublishCalls: number | undefined } => ({
  maxThreadPublishCalls: undefined,
}));

vi.mock("../src/settings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/index.js")>();
  return {
    ...actual,
    get MAX_THREAD_PUBLISH_CALLS() {
      return settingsOverrides.maxThreadPublishCalls ?? actual.MAX_THREAD_PUBLISH_CALLS;
    },
  };
});

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  let reviewId = 100;
  return {
    ...actual,
    createPullRequestReviewWithComments: vi.fn(async () => {
      reviewId += 1;
      return { id: reviewId, url: `https://example.com/reviews/${reviewId}` };
    }),
  };
});

import { createPullRequestReviewWithComments } from "../src/github/reviewPublish.js";

function finding(line: number): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Bug at line ${line}`,
    detail: `The changed path at line ${line} returns the wrong value.`,
    fixPrompt: `Correct the path at line ${line}.`,
  };
}

function buildTool(getToken: () => string, shouldAbortPublish?: () => Promise<boolean>) {
  return buildPublishThreadTool({
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "abc1234",
      hasDescriptionReviewMap: false,
    },
    workItemId: "wi-1",
    progressCommentUrl: "https://github.com/o/r/pull/1#issuecomment-99",
    getToken,
    cachedDiffIndex: cachedDiffForLines("src/a.ts", [10, 20]),
    recordPublishStep: vi.fn(async () => undefined),
    shouldAbortPublish,
    initialLedger: createFindingLedger(),
  });
}

describe("buildPublishThreadTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsOverrides.maxThreadPublishCalls = undefined;
  });

  it("carries the finding ledger across calls and reports same-file published threads", async () => {
    const tool = buildTool(() => "token");
    tool.setSource("correctness");

    const first = await tool.executor({ findings: [finding(10)] });
    tool.setSource("security");
    const second = await tool.executor({ findings: [finding(10), finding(20)] });

    expect(tool.piTool.name).toBe("publish_thread");
    expect(first.kind).toBe("published");
    expect(first.publishedThreadOverlapHints).toEqual([
      expect.objectContaining({
        file: "src/a.ts",
        startLine: 10,
        title: "Bug at line 10",
      }),
    ]);
    expect(second.kind).toBe("published");
    expect(second.publishedThreadOverlapHints).toEqual([
      expect.objectContaining({ startLine: 10 }),
      expect.objectContaining({ startLine: 20 }),
    ]);
    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(2);
    expect(tool.getLedger().accepted).toHaveLength(2);
    expect(tool.getLedger().accepted.map((placement) => placement.source)).toEqual([
      "correctness",
      "security",
    ]);
    expect(tool.getLedger().postedInlineCount).toBe(2);
    expect(tool.getLedger().threadCallCount).toBe(2);
    expect(tool.getPublishedBatchCount()).toBe(2);
  });

  it("retains budget-exhausted findings as summary-only ledger entries", async () => {
    settingsOverrides.maxThreadPublishCalls = 1;
    const tool = buildTool(() => "token");
    tool.setSource("security");

    await tool.executor({ findings: [finding(10)] });
    const result = await tool.executor({ findings: [finding(20)] });

    expect(result.kind).toBe("budget_exhausted");
    expect(tool.getLedger().accepted).toEqual([
      expect.objectContaining({ kind: "posted", source: "security" }),
      expect.objectContaining({
        kind: "summary_only",
        source: "security",
        reason: "budget",
      }),
    ]);
    expect(tool.getLedger().threadBudgetExhausted).toBe(true);
    expect(tool.getPublishedBatchCount()).toBe(1);
  });

  it("reads the live token getter for each publish call", async () => {
    let token = "first-token";
    const tool = buildTool(() => token);
    tool.setSource("quality");

    await tool.executor({ findings: [finding(10)] });
    token = "refreshed-token";
    await tool.executor({ findings: [finding(20)] });

    expect(vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[0]).toBe("first-token");
    expect(vi.mocked(createPullRequestReviewWithComments).mock.calls[1]?.[0]).toBe(
      "refreshed-token",
    );
  });

  it("rejects malformed calls and calls made before a specialist source is selected", async () => {
    const tool = buildTool(() => "token");

    await expect(tool.executor({ findings: "not-an-array" })).rejects.toMatchObject({
      code: "review.publish_thread_validation_failed",
    });
    await expect(tool.executor({ findings: [finding(10)] })).rejects.toMatchObject({
      code: "review.publish_thread_source_required",
    });
    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(tool.getPublishedBatchCount()).toBe(0);
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });

  it("leaves the ledger unchanged when the publish gate stops the call", async () => {
    const tool = buildTool(
      () => "token",
      async () => true,
    );
    tool.setSource("tests");

    const result = await tool.executor({ findings: [finding(10)] });

    expect(result.kind).toBe("stopped");
    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
  });

  it("leaves the ledger unchanged when GitHub publish throws", async () => {
    vi.mocked(createPullRequestReviewWithComments).mockRejectedValueOnce(
      new Error("GitHub unavailable"),
    );
    const tool = buildTool(() => "token");
    tool.setSource("quality");

    await expect(tool.executor({ findings: [finding(10)] })).rejects.toMatchObject({
      code: "review.publish_thread_failed",
    });

    expect(tool.getLedger()).toEqual(createFindingLedger());
    expect(tool.getPublishedBatchCount()).toBe(0);
  });
});
