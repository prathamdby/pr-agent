import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import type { ReviewThreadResolution } from "../src/github/reviewThreadResolution.js";
import type { VerificationPayload } from "../src/review/triageSchema.js";

const mocks = vi.hoisted(() => ({
  createReply: vi.fn(),
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

vi.mock("../src/github/reviewThreadResolution.js", () => ({
  resolveReviewThread: mocks.resolve,
}));

vi.mock("../src/agentWork/repository.js", () => ({
  recordPublishStep: mocks.recordPublishStep,
}));

import { publishVerification } from "../src/agent/verification/publishVerification.js";

const thread = {
  rootCommentId: 1,
  lens: "review" as const,
  path: "src/app.ts",
  line: 1,
  severity: "P1" as const,
  titleSnippet: "P1 · Bug",
  humanReplies: [],
  threadUrl: "https://github.test/thread",
} satisfies BotFindingThread;

const secondThread = {
  ...thread,
  rootCommentId: 2,
  titleSnippet: "P2 · Other",
} satisfies BotFindingThread;

const thirdThread = {
  ...thread,
  rootCommentId: 3,
  path: "src/other.ts",
  titleSnippet: "P1 · Unchanged path",
} satisfies BotFindingThread;

function pool(detail?: unknown): Pool {
  return {
    query: vi.fn(async () => ({ rows: detail === undefined ? [] : [{ detail }] })),
  } as unknown as Pool;
}

function resolutionMap(
  entries: readonly [number, ReviewThreadResolution][],
): Map<number, ReviewThreadResolution> {
  return new Map(entries);
}

function baseParams(overrides: {
  readonly payload: VerificationPayload;
  readonly inventory?: readonly BotFindingThread[];
  readonly resolutionByRootCommentId?: ReadonlyMap<number, ReviewThreadResolution>;
  readonly changedFilePaths?: readonly string[];
  readonly pool?: Pool;
}) {
  return {
    pool: overrides.pool ?? pool(),
    workItemId: "wi",
    resourceKey: "o/r#1",
    token: "tok",
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    inventory: overrides.inventory ?? [thread, secondThread, thirdThread],
    resolutionByRootCommentId:
      overrides.resolutionByRootCommentId ??
      resolutionMap([
        [1, { threadNodeId: "PRRT_1", isResolved: false }],
        [2, { threadNodeId: "PRRT_2", isResolved: false }],
        [3, { threadNodeId: "PRRT_3", isResolved: false }],
      ]),
    payload: overrides.payload,
    changedFilePaths: overrides.changedFilePaths ?? ["src/app.ts"],
  };
}

describe("publishVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordPublishStep.mockResolvedValue(undefined);
    mocks.createReply.mockResolvedValue(undefined);
    mocks.resolve.mockResolvedValue(undefined);
  });

  it("silently resolves fixed and already-resolved threads without replying", async () => {
    const result = await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "null check added",
            },
            {
              verdict: "already-resolved",
              threadRootCommentId: 2,
              evidence: "code already guards this path",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: false });
    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "PRRT_1", undefined);
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "PRRT_2", undefined);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: { actedThreadIds: [1] },
      }),
    );
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: { actedThreadIds: [1, 2] },
      }),
    );
  });

  it("skips resolve when the thread is already resolved", async () => {
    await publishVerification(
      baseParams({
        resolutionByRootCommentId: resolutionMap([
          [1, { threadNodeId: "PRRT_1", isResolved: true }],
        ]),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.recordPublishStep).not.toHaveBeenCalled();
  });

  it("replies only for still-open findings on changed files", async () => {
    await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "guard still missing",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 3,
              reason: "still open but file unchanged",
            },
          ],
        },
      }),
    );

    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.createReply).toHaveBeenCalledTimes(1);
    expect(mocks.createReply).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 1,
        body: expect.stringContaining("still open"),
      }),
    );
  });

  it("replies for dismissed findings with a policy suggestion", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, humanReplies: ["false positive"] }],
        payload: {
          verdicts: [
            {
              verdict: "dismissed",
              threadRootCommentId: 1,
              evidence: "maintainer marked false positive",
            },
          ],
        },
      }),
    );

    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.createReply).toHaveBeenCalledTimes(1);
    expect(mocks.createReply).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 1,
        body: expect.stringMatching(/dismissed[\s\S]*Suggested policy entry/),
      }),
    );
  });

  it("does not re-reply or re-record when thread was already acted", async () => {
    await publishVerification(
      baseParams({
        pool: pool({ actedThreadIds: [1] }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "still open",
            },
          ],
        },
      }),
    );

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.recordPublishStep).not.toHaveBeenCalled();
  });

  it("marks degraded when inventory mapping is missing", async () => {
    const result = await publishVerification(
      baseParams({
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 99,
              reason: "orphan",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: true });
    expect(mocks.createReply).not.toHaveBeenCalled();
  });

  it("marks degraded when fixed thread has no resolution mapping", async () => {
    const result = await publishVerification(
      baseParams({
        inventory: [thread],
        resolutionByRootCommentId: resolutionMap([]),
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
          ],
        },
      }),
    );

    expect(result).toEqual({ degraded: true });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.createReply).not.toHaveBeenCalled();
  });

  it("mixes silent resolve with still-open replies in one payload", async () => {
    await publishVerification(
      baseParams({
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "fixed",
            },
            {
              verdict: "skipped",
              threadRootCommentId: 2,
              reason: "still broken",
            },
          ],
        },
      }),
    );

    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "PRRT_1", undefined);
    expect(mocks.createReply).toHaveBeenCalledTimes(1);
    expect(mocks.createReply).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 2,
        body: expect.stringContaining("still open"),
      }),
    );
  });
});
