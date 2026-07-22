import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { BotFindingThread } from "../src/review/run/reviewPriorFeedback.js";
import type { ReviewThreadResolution } from "../src/github/reviewThreadResolution.js";
import type { VerificationPayload } from "../src/review/triageSchema.js";
import { VERIFICATION_STUB_MARKER } from "../src/settings/index.js";

const mocks = vi.hoisted(() => ({
  createReply: vi.fn(),
  updateComment: vi.fn(),
  resolve: vi.fn(),
  recordPublishStep: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: {
        createReplyForReviewComment: mocks.createReply,
        updateReviewComment: mocks.updateComment,
      },
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
  readonly workItemId?: string;
  readonly policyResult?: Parameters<typeof publishVerification>[0]["policyResult"];
}) {
  return {
    pool: overrides.pool ?? pool(),
    workItemId: overrides.workItemId ?? "wi",
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
    policyResult: overrides.policyResult ?? ({ kind: "absent" } as const),
  };
}

describe("publishVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordPublishStep.mockResolvedValue(undefined);
    mocks.createReply.mockResolvedValue({ data: { id: 9001 } });
    mocks.updateComment.mockResolvedValue({ data: { id: 9001 } });
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
    expect(mocks.updateComment).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "verification_thread_actions",
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
            "2": {
              lastVerdict: "already-resolved",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
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
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("edits a prior still-open stub when later marking fixed", async () => {
    mocks.updateComment.mockResolvedValueOnce({ data: {} });

    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "fixed",
              threadRootCommentId: 1,
              commitSha: "abcdef1",
              evidence: "tests cover the case",
            },
          ],
        },
      }),
    );

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 555,
        body: expect.stringContaining("**Verification**: Fixed"),
      }),
    );
    expect(mocks.updateComment.mock.calls[0]?.[0]?.body).toContain(VERIFICATION_STUB_MARKER);
    expect(mocks.updateComment.mock.calls[0]?.[0]?.body).not.toContain("Still open");
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "PRRT_1", undefined);
  });

  it("creates a marked still-open stub only for findings on changed files", async () => {
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
        body: expect.stringContaining(VERIFICATION_STUB_MARKER),
      }),
    );
    expect(mocks.createReply.mock.calls[0]?.[0]?.body).toContain("Still open");
  });

  it("edits an existing stub in place on later still-open publishes", async () => {
    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped", lastHeadSha: "b".repeat(40) },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "still open after push",
            },
          ],
        },
      }),
    );

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.updateComment).toHaveBeenCalledTimes(1);
    expect(mocks.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 555,
        body: expect.stringContaining("still open after push"),
      }),
    );
  });

  it("recovers stub id from inventory marker when ledger lacks stubCommentId", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, verificationStubCommentId: 777 }],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "recovered",
            },
          ],
        },
      }),
    );

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 777 }));
  });

  it("dismisses by editing stub, grounding policy, and resolving the thread", async () => {
    await publishVerification(
      baseParams({
        inventory: [
          { ...thread, humanReplies: ["false positive"], verificationStubCommentId: 555 },
        ],
        policyResult: {
          kind: "ok",
          policy: {
            rules: [
              {
                filename: "src.mdc",
                relativePath: ".pr-agent/src.mdc",
                alwaysApply: false,
                globs: ["src/**"],
                body: "existing",
              },
            ],
          },
        },
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

    expect(mocks.createReply).not.toHaveBeenCalled();
    expect(mocks.updateComment).toHaveBeenCalledTimes(1);
    const body = mocks.updateComment.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("Dismissed");
    expect(body).toContain("Append this to `.pr-agent/src.mdc`:");
    expect(body).not.toContain("pathInstructions");
    expect(body).not.toContain(".pr-agent.yml");
    expect(mocks.resolve).toHaveBeenCalledWith("tok", "PRRT_1", undefined);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 555,
              lastVerdict: "dismissed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("creates then resolves when dismissing without an existing stub", async () => {
    await publishVerification(
      baseParams({
        inventory: [{ ...thread, humanReplies: ["intentional"] }],
        payload: {
          verdicts: [
            {
              verdict: "dismissed",
              threadRootCommentId: 1,
              evidence: "intentional",
            },
          ],
        },
      }),
    );

    expect(mocks.createReply).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 9001,
              lastVerdict: "dismissed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
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

  it("mixes silent resolve with still-open stub creates in one payload", async () => {
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
        body: expect.stringContaining("Still open"),
      }),
    );
  });

  it("falls back to create when updating a deleted stub returns 404", async () => {
    mocks.updateComment.mockRejectedValueOnce({ status: 404 });
    mocks.createReply.mockResolvedValueOnce({ data: { id: 9900 } });

    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped" },
          },
        }),
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "stub was deleted",
            },
          ],
        },
      }),
    );

    expect(mocks.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 555 }));
    expect(mocks.createReply).toHaveBeenCalledTimes(1);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 9900,
              lastVerdict: "skipped",
              lastHeadSha: "a".repeat(40),
            },
          },
        },
      }),
    );
  });

  it("preserves stubCommentId when a later fixed verdict has no stub id", async () => {
    mocks.updateComment.mockResolvedValueOnce({ data: {} });

    await publishVerification(
      baseParams({
        pool: pool({
          threads: {
            "1": { stubCommentId: 555, lastVerdict: "skipped" },
          },
        }),
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
    expect(mocks.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 555,
        body: expect.stringContaining("**Verification**: Fixed"),
      }),
    );
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: {
          threads: {
            "1": {
              stubCommentId: 555,
              lastVerdict: "fixed",
              lastHeadSha: "a".repeat(40),
              terminal: true,
            },
          },
        },
      }),
    );
  });

  it("loads ledger by resource key so prior stubs survive a new work item", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          detail: {
            threads: {
              "1": { stubCommentId: 4242, lastVerdict: "skipped" },
            },
          },
        },
      ],
    }));
    await publishVerification(
      baseParams({
        pool: { query } as unknown as Pool,
        workItemId: "wi-new",
        inventory: [thread],
        payload: {
          verdicts: [
            {
              verdict: "skipped",
              threadRootCommentId: 1,
              reason: "cross work item",
            },
          ],
        },
      }),
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("resource_key"),
      expect.arrayContaining(["o/r#1"]),
    );
    expect(mocks.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 4242 }));
    expect(mocks.createReply).not.toHaveBeenCalled();
  });
});
