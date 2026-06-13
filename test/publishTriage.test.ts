import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  StaleHeadPushError,
  type WritablePrCheckout,
} from "../src/prWorkspace/writablePrCheckout.js";

const mocks = vi.hoisted(() => ({
  createReply: vi.fn(),
  upsert: vi.fn(),
  resolve: vi.fn(),
  recordPublishStep: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: { createReplyForReviewComment: mocks.createReply },
    },
  })),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: mocks.upsert,
}));

vi.mock("../src/github/reviewThreadResolution.js", () => ({
  resolveReviewThread: mocks.resolve,
}));

vi.mock("../src/agentWork/repository.js", () => ({
  recordPublishStep: mocks.recordPublishStep,
}));

import { publishTriage } from "../src/agent/publishTriage.js";

const thread = {
  rootCommentId: 1,
  lens: "review" as const,
  path: "src/app.ts",
  line: 1,
  severity: "P1" as const,
  titleSnippet: "P1 · Bug",
  humanReplies: [],
  threadUrl: "https://github.test/thread",
};
const secondThread = { ...thread, rootCommentId: 2, titleSnippet: "P2 · Already fixed" };

function checkout(push: () => Promise<void>): WritablePrCheckout {
  return {
    dir: "/tmp/checkout",
    headRef: "main",
    baseSha: "a".repeat(40),
    commit: vi.fn(),
    push,
    listCommittedShas: () => ["abcdef123456"],
    listCommittedDetails: () => [
      { sha: "abcdef123456", subject: "fix: guard user", diff: "+ok\n" },
    ],
  };
}

function pool(detail?: unknown): Pool {
  return {
    query: vi.fn(async () => ({ rows: detail === undefined ? [] : [{ detail }] })),
  } as unknown as Pool;
}

function poolWithPriorRunActedIds(): Pool {
  return {
    query: vi.fn(async (_sql, args: readonly unknown[]) => ({
      rows: args[0] === "wi" ? [] : [{ detail: { actedThreadIds: [1] } }],
    })),
  } as unknown as Pool;
}

describe("publishTriage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsert.mockResolvedValue({ id: 99, updated: false });
    mocks.recordPublishStep.mockResolvedValue(undefined);
    mocks.createReply.mockResolvedValue(undefined);
    mocks.resolve.mockResolvedValue(undefined);
  });

  it("posts no thread replies when push is stale", async () => {
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      resourceKey: "o/r#1",
      token: "tok",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => {
        throw new StaleHeadPushError();
      }),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "abcdef123456",
            evidence: "fixed",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(result.degraded).toBe(true);
    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.upsert.mock.calls[0]?.[4]).toContain("head changed");
  });

  it("still replies to already-resolved verdicts when push is stale", async () => {
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      resourceKey: "o/r#1",
      token: "tok",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => {
        throw new StaleHeadPushError();
      }),
      inventory: [thread, secondThread],
      resolutionByRootCommentId: new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
      payload: {
        verdicts: [
          {
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "abcdef123456",
            evidence: "fixed",
          },
          {
            verdict: "already-resolved",
            threadRootCommentId: 2,
            evidence: "current code already handles this",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(result.degraded).toBe(true);
    expect(mocks.createReply).toHaveBeenCalledTimes(1);
    expect(mocks.createReply).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 2, body: expect.stringContaining("already resolved") }),
    );
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "node-2", undefined);
    expect(mocks.upsert.mock.calls[0]?.[4]).toContain("head changed");
  });

  it("skips already acted ids and never resolves dismissed verdicts", async () => {
    await publishTriage({
      pool: pool({ actedThreadIds: [1] }),
      workItemId: "wi",
      resourceKey: "o/r#1",
      token: "tok",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => undefined),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: {
        verdicts: [
          {
            verdict: "dismissed",
            threadRootCommentId: 1,
            evidence: "maintainer said intentional",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("does not reuse acted thread ids from prior triage work items", async () => {
    await publishTriage({
      pool: poolWithPriorRunActedIds(),
      workItemId: "wi",
      resourceKey: "o/r#1",
      token: "tok",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => undefined),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: {
        verdicts: [
          {
            verdict: "already-resolved",
            threadRootCommentId: 1,
            evidence: "current code already handles this",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(mocks.createReply).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 1 }));
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "node", undefined);
  });
});
