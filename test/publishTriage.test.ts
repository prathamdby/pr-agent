import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  StaleHeadPushError,
  type WritablePrCheckout,
} from "../src/prWorkspace/writablePrCheckout.js";
import { TriageClosedPullRequestError } from "../src/agent/triage/triageErrors.js";
import { isPullRequestOpenAndUnmerged } from "../src/github/listPullRequestFiles.js";

import {
  publishTestPrSurface,
  resolveThreadIds,
  upsertProgressBody,
} from "./helpers/publishPrSurface.js";

vi.mock("../src/agentWork/repository.js", () => ({
  recordPublishStep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/agentWork/prActorLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/prActorLease.js")>();
  return {
    ...actual,
    assertPrActorLeaseHeld: vi.fn().mockResolvedValue(undefined),
    isPrActorLeaseHeld: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/agentWork/triageAnalytics.js", () => ({
  captureTriageEvent: vi.fn(),
  captureTriageFailure: vi.fn(),
}));

import { recordPublishStep } from "../src/agentWork/repository.js";
import { triagePushOperationKey } from "../src/agentWork/withOperationIntent.js";
import {
  isTriagePushOutcome,
  parseStoredTriagePushDetail,
  publishTriage,
  publishTriagePreview,
  publishTriageReportOnly,
  type TriagePushOutcome,
} from "../src/agent/triage/publishTriage.js";
import {
  TRIAGE_BULK_PARTIAL_NOTICE,
  TRIAGE_CLOSED_PR_NOTICE,
  TRIAGE_PREVIEW_SENTINEL,
  TRIAGE_STALE_HEAD_NOTICE,
  TRIAGE_SUMMARY_SENTINEL,
} from "../src/settings/index.js";
import { memoryOperationIntentStore } from "./setup/operationIntent-memory.js";

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

function emptyCheckout(push: () => Promise<void>): WritablePrCheckout {
  return {
    dir: "/tmp/checkout",
    headRef: "main",
    baseSha: "a".repeat(40),
    commit: vi.fn(),
    push,
    listCommittedShas: () => [],
    listCommittedDetails: () => [],
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

function triagePushRecords(): Array<Record<string, unknown> | undefined> {
  return vi
    .mocked(recordPublishStep)
    .mock.calls.flatMap(([, params]) => (params.step === "triage_push" ? [params.detail] : []));
}

const closedLifecycles = [
  ["closed", { state: "closed", merged: false, merged_at: null }],
  ["merged", { state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z" }],
] as const;

describe("publishTriage", () => {
  let controls: import("../src/github/fakePrSurface.js").FakePrSurfaceControls;

  beforeEach(() => {
    vi.clearAllMocks();
    controls = publishTestPrSurface().controls;
  });

  it("posts no thread replies when push is stale", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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

    expect(result).toEqual({ pushOutcome: "stale", missingThreadAction: false });
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(upsertProgressBody(controls)).toContain("head changed");
    expect(upsertProgressBody(controls)).toContain(TRIAGE_STALE_HEAD_NOTICE);
  });

  it("records a closed PR as terminal no-push and skips fixed-thread actions", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => {
        throw new TriageClosedPullRequestError();
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

    expect(result).toEqual({ pushOutcome: "closed", missingThreadAction: false });
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(upsertProgressBody(controls)).toContain(TRIAGE_CLOSED_PR_NOTICE);
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "triage_push",
        detail: expect.objectContaining({ pushOutcome: "closed" }),
      }),
    );
  });

  it("records attempted commits when the PR closes between commit and push", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const committedSha = "c".repeat(40);
    const committed = [{ sha: committedSha, subject: "fix: guard user", diff: "+ok\n" }];
    const remotePush = vi.fn(async () => undefined);
    const commit = vi.fn(async () => ({ sha: committedSha, diff: "+ok\n" }));
    const push = vi.fn(async () => {
      const { pullRequest } = await fake.surface.getHead();
      if (!isPullRequestOpenAndUnmerged(pullRequest)) {
        throw new TriageClosedPullRequestError();
      }
      await remotePush();
    });
    const raceCheckout: WritablePrCheckout = {
      dir: "/tmp/checkout",
      headRef: "main",
      baseSha: "a".repeat(40),
      commit,
      push,
      listCommittedShas: () => committed.map((entry) => entry.sha),
      listCommittedDetails: () => [...committed],
    };

    await raceCheckout.commit({ files: ["src/app.ts"], subject: "fix: guard user" });
    controls.setPullRequest({
      additions: 1,
      deletions: 0,
      changed_files: 1,
      state: "closed",
      merged: false,
      merged_at: null,
      head: { sha: "a".repeat(40) },
    });

    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: raceCheckout,
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: { verdicts: [fixedVerdict] },
      previouslyResolvedCount: 0,
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(remotePush).not.toHaveBeenCalled();
    expect(result).toEqual({ pushOutcome: "closed", missingThreadAction: false });
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(upsertProgressBody(controls)).toContain(TRIAGE_CLOSED_PR_NOTICE);
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "triage_push",
        detail: expect.objectContaining({
          pushOutcome: "closed",
          attemptedShas: [committedSha],
        }),
      }),
    );
  });

  it.each(closedLifecycles)(
    "records a push that raced a %s PR as terminal no-push without success artifacts",
    async (_label, lifecycle) => {
      const fake = publishTestPrSurface();
      controls = fake.controls;
      const committedSha = "c".repeat(40);
      const committed = [{ sha: committedSha, subject: "fix: guard user", diff: "+ok\n" }];
      const remotePush = vi.fn(async () => undefined);
      const push = vi.fn(async () => {
        const { pullRequest } = await fake.surface.getHead();
        if (!isPullRequestOpenAndUnmerged(pullRequest)) {
          throw new TriageClosedPullRequestError();
        }
        await remotePush();
        controls.setPullRequest({
          additions: 1,
          deletions: 0,
          changed_files: 1,
          ...lifecycle,
          head: { sha: "a".repeat(40) },
        });
      });
      const raceCheckout: WritablePrCheckout = {
        dir: "/tmp/checkout",
        headRef: "main",
        baseSha: "a".repeat(40),
        commit: vi.fn(),
        push,
        listCommittedShas: () => committed.map((entry) => entry.sha),
        listCommittedDetails: () => [...committed],
      };

      const result = await publishTriage({
        pool: pool(),
        workItemId: "wi",
        leaseEpoch: 1,
        resourceKey: "o/r#1",
        installationId: 42,
        prSurface: fake.surface,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a".repeat(40),
        checkout: raceCheckout,
        inventory: [thread],
        resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
        payload: { verdicts: [fixedVerdict] },
        previouslyResolvedCount: 0,
      });

      expect(remotePush).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ pushOutcome: "closed", missingThreadAction: false });
      expect(controls.replies).toHaveLength(0);
      expect(resolveThreadIds(controls)).toHaveLength(0);
      const body = upsertProgressBody(controls);
      expect(body).toContain(TRIAGE_CLOSED_PR_NOTICE);
      expect(body).not.toContain("Pushed commits:");
      const pushRecords = triagePushRecords();
      expect(pushRecords).toHaveLength(1);
      expect(pushRecords[0]).toEqual(
        expect.objectContaining({ pushOutcome: "closed", attemptedShas: [committedSha] }),
      );
      expect(pushRecords[0]).not.toHaveProperty("pushedShas");
    },
  );

  it("replies and resolves a fixed thread after a successful push", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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
            verdict: "fixed",
            threadRootCommentId: 1,
            commitSha: "abcdef123456",
            evidence: "fixed",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(result).toEqual({ pushOutcome: "pushed", missingThreadAction: false });
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.body).toContain("Fixed in");
    expect(resolveThreadIds(controls)).toContain("node");
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "triage_push",
        detail: expect.objectContaining({
          pushOutcome: "pushed",
          pushedShas: ["abcdef123456"],
        }),
      }),
    );
  });

  it("still replies to already-resolved verdicts when push is stale", async () => {
    const fake = publishTestPrSurface(
      new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
    );
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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

    expect(result).toEqual({ pushOutcome: "stale", missingThreadAction: false });
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.target).toEqual(
      expect.objectContaining({ kind: "inlineReviewThread", inReplyToCommentId: 2 }),
    );
    expect(controls.replies[0]?.body).toContain("Already resolved");
    expect(resolveThreadIds(controls)).toContain("node-2");
    expect(upsertProgressBody(controls)).toContain("head changed");
  });

  it("resolves dismissed threads without a new reply", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toContain("node");
  });

  it("still resolves dismissed verdicts when push is stale", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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
            verdict: "dismissed",
            threadRootCommentId: 1,
            evidence: "maintainer said intentional",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(result).toEqual({ pushOutcome: "stale", missingThreadAction: false });
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toContain("node");
  });

  it("does not resolve skipped threads", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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
            verdict: "skipped",
            threadRootCommentId: 1,
            reason: "too large for one commit",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
  });

  it("resolves dismissed and already-resolved threads when the checkout has no commits", async () => {
    const push = vi.fn(async () => undefined);
    const fake = publishTestPrSurface(
      new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
    );
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: emptyCheckout(push),
      inventory: [thread, secondThread],
      resolutionByRootCommentId: new Map([
        [1, { threadNodeId: "node-1", isResolved: false }],
        [2, { threadNodeId: "node-2", isResolved: false }],
      ]),
      payload: {
        verdicts: [
          {
            verdict: "dismissed",
            threadRootCommentId: 1,
            evidence: "maintainer said intentional",
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

    expect(result).toEqual({ pushOutcome: "not-needed", missingThreadAction: false });
    expect(push).not.toHaveBeenCalled();
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.target).toEqual(
      expect.objectContaining({ kind: "inlineReviewThread", inReplyToCommentId: 2 }),
    );
    expect(resolveThreadIds(controls)).toEqual(expect.arrayContaining(["node-1", "node-2"]));
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "triage_push",
        detail: expect.objectContaining({ pushOutcome: "not-needed", pushedShas: [] }),
      }),
    );
  });

  it("does not resolve a fixed thread when the checkout has no commits", async () => {
    const push = vi.fn(async () => undefined);
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: emptyCheckout(push),
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

    expect(result).toEqual({ pushOutcome: "not-needed", missingThreadAction: false });
    expect(push).not.toHaveBeenCalled();
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "triage_push",
        detail: expect.objectContaining({ pushOutcome: "not-needed" }),
      }),
    );
  });

  it("skips duplicate replies but still resolves already acted threads", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool({ actedThreadIds: [1] }),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toContain("node");
  });

  it("skips replies when the thread already has a bot triage reply", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => undefined),
      inventory: [{ ...thread, hasTriageReply: true }],
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

    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toContain("node");
  });

  it("does not reuse acted thread ids from prior triage work items", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: poolWithPriorRunActedIds(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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

    expect(controls.replies[0]?.target).toEqual(expect.objectContaining({ inReplyToCommentId: 1 }));
    expect(resolveThreadIds(controls)).toContain("node");
  });

  it("marks publish degraded when an actionable verdict lacks thread mapping", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => undefined),
      inventory: [thread],
      resolutionByRootCommentId: new Map(),
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

    expect(result).toEqual({ pushOutcome: "pushed", missingThreadAction: true });
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(upsertProgressBody(controls)).toContain("could not be matched");
  });

  it("redacts secret-shaped substrings in the triage report body before upsert", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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
            evidence:
              "False positive; leaked Bearer ghp_1234567890123456789012345678901234 in prior run",
          },
        ],
      },
      previouslyResolvedCount: 0,
    });

    const body = upsertProgressBody(controls);
    expect(resolveThreadIds(controls)).toContain("node");
    expect(body).toContain("Policy suggestions for dismissed findings");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("ghp_");
    expect(body).not.toContain("Bearer ghp_");
  });

  it("preserves clean triage report formatting through the upsert chokepoint", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
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

    const body = upsertProgressBody(controls);
    expect(body.startsWith(TRIAGE_SUMMARY_SENTINEL)).toBe(true);
    expect(body).toContain("| Severity | Finding | Location | Verdict | Thread |");
    expect(body).toContain("Already resolved");
    expect(body).toContain(
      "0 Fixed · 1 Already resolved · 0 Skipped · 0 Dismissed · 0 Previously resolved",
    );
  });

  it("redacts report-only bodies at the same upsert chokepoint", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriageReportOnly({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      inventory: [thread],
      previouslyResolvedCount: 0,
      body: `${TRIAGE_SUMMARY_SENTINEL}\n\nInventory leaked OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n`,
    });

    const body = upsertProgressBody(controls);
    expect(body.startsWith(TRIAGE_SUMMARY_SENTINEL)).toBe(true);
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("sk-");
    expect(body).toContain("Inventory leaked");
  });
});

const skippedVerdict = {
  verdict: "skipped" as const,
  threadRootCommentId: 1,
  reason: "too large for one commit",
};
const dismissedVerdict = {
  verdict: "dismissed" as const,
  threadRootCommentId: 1,
  evidence: "maintainer said intentional",
};
const alreadyResolvedVerdict = {
  verdict: "already-resolved" as const,
  threadRootCommentId: 1,
  evidence: "current code already handles this",
};
const fixedVerdict = {
  verdict: "fixed" as const,
  threadRootCommentId: 1,
  commitSha: "abcdef123456",
  evidence: "fixed",
};

const storedPayload = { verdicts: [skippedVerdict] };
const storedCommit = { sha: "abcdef123456", subject: "fix: guard user", diff: "+ok\n" };

describe("parseStoredTriagePushDetail", () => {
  it("infers stale from legacy staleHead and keeps explicit pushOutcome", () => {
    expect(isTriagePushOutcome("not-needed")).toBe(true);
    expect(isTriagePushOutcome("pushed")).toBe(true);
    expect(isTriagePushOutcome("stale")).toBe(true);
    expect(isTriagePushOutcome("closed")).toBe(true);
    expect(isTriagePushOutcome("degraded")).toBe(false);

    expect(
      parseStoredTriagePushDetail({
        staleHead: true,
        commits: [storedCommit],
        payload: storedPayload,
      }),
    ).toEqual(
      expect.objectContaining({
        pushOutcome: "stale",
        commits: [storedCommit],
      }),
    );
    expect(
      parseStoredTriagePushDetail({
        commits: [storedCommit],
        pushedHeadSha: "a".repeat(40),
        payload: storedPayload,
      }),
    ).toEqual(
      expect.objectContaining({
        pushOutcome: "pushed",
        pushedHeadSha: "a".repeat(40),
      }),
    );
    expect(
      parseStoredTriagePushDetail({
        commits: [],
        pushedHeadSha: "a".repeat(40),
        payload: storedPayload,
      }),
    ).toEqual(expect.objectContaining({ pushOutcome: "not-needed" }));
    expect(
      parseStoredTriagePushDetail({
        pushOutcome: "not-needed",
        staleHead: true,
        commits: [storedCommit],
        payload: storedPayload,
      }),
    ).toEqual(expect.objectContaining({ pushOutcome: "not-needed" }));
    expect(
      parseStoredTriagePushDetail({
        pushOutcome: "closed",
        attemptedShas: [storedCommit.sha],
        commits: [storedCommit],
        payload: storedPayload,
      }),
    ).toEqual(
      expect.objectContaining({
        pushOutcome: "closed",
        commits: [storedCommit],
        payload: storedPayload,
      }),
    );
  });

  it("rejects invalid stored payloads", () => {
    expect(parseStoredTriagePushDetail(null)).toBeNull();
    expect(parseStoredTriagePushDetail({ commits: [storedCommit] })).toBeNull();
    expect(
      parseStoredTriagePushDetail({
        payload: storedPayload,
        commits: [{ sha: "missing-fields" }],
      }),
    ).toBeNull();
  });
});

describe("publishTriage push outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<{
    readonly outcome: TriagePushOutcome;
    readonly verdict:
      | typeof fixedVerdict
      | typeof alreadyResolvedVerdict
      | typeof dismissedVerdict
      | typeof skippedVerdict;
    readonly expectReply: boolean;
    readonly expectResolve: boolean;
  }> = [
    { outcome: "not-needed", verdict: fixedVerdict, expectReply: false, expectResolve: false },
    {
      outcome: "not-needed",
      verdict: alreadyResolvedVerdict,
      expectReply: true,
      expectResolve: true,
    },
    { outcome: "not-needed", verdict: dismissedVerdict, expectReply: false, expectResolve: true },
    { outcome: "not-needed", verdict: skippedVerdict, expectReply: false, expectResolve: false },
    { outcome: "pushed", verdict: fixedVerdict, expectReply: true, expectResolve: true },
    { outcome: "pushed", verdict: alreadyResolvedVerdict, expectReply: true, expectResolve: true },
    { outcome: "pushed", verdict: dismissedVerdict, expectReply: false, expectResolve: true },
    { outcome: "pushed", verdict: skippedVerdict, expectReply: false, expectResolve: false },
    { outcome: "stale", verdict: fixedVerdict, expectReply: false, expectResolve: false },
    { outcome: "stale", verdict: alreadyResolvedVerdict, expectReply: true, expectResolve: true },
    { outcome: "stale", verdict: dismissedVerdict, expectReply: false, expectResolve: true },
    { outcome: "stale", verdict: skippedVerdict, expectReply: false, expectResolve: false },
    { outcome: "closed", verdict: fixedVerdict, expectReply: false, expectResolve: false },
    {
      outcome: "closed",
      verdict: alreadyResolvedVerdict,
      expectReply: true,
      expectResolve: true,
    },
    { outcome: "closed", verdict: dismissedVerdict, expectReply: false, expectResolve: true },
    { outcome: "closed", verdict: skippedVerdict, expectReply: false, expectResolve: false },
  ];

  it.each(cases)(
    "$outcome + $verdict.verdict → reply=$expectReply resolve=$expectResolve",
    async ({ outcome, verdict, expectReply, expectResolve }) => {
      const fake = publishTestPrSurface();
      const push = vi.fn(async () => {
        if (outcome === "stale") throw new StaleHeadPushError();
        if (outcome === "closed") throw new TriageClosedPullRequestError();
      });
      const result = await publishTriage({
        pool: pool(),
        workItemId: "wi",
        leaseEpoch: 1,
        resourceKey: "o/r#1",
        installationId: 42,
        prSurface: fake.surface,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a".repeat(40),
        checkout: outcome === "not-needed" ? emptyCheckout(push) : checkout(push),
        inventory: [thread],
        resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
        payload: { verdicts: [verdict] },
        previouslyResolvedCount: 0,
      });

      expect(result).toEqual({ pushOutcome: outcome, missingThreadAction: false });
      expect(fake.controls.replies).toHaveLength(expectReply ? 1 : 0);
      expect(resolveThreadIds(fake.controls)).toEqual(expectResolve ? ["node"] : []);
    },
  );

  it.each(["not-needed", "pushed", "stale"] as const)(
    "keeps pushOutcome %s when a thread mapping is missing",
    async (outcome) => {
      const fake = publishTestPrSurface();
      const push = vi.fn(async () => {
        if (outcome === "stale") throw new StaleHeadPushError();
      });
      const result = await publishTriage({
        pool: pool(),
        workItemId: "wi",
        leaseEpoch: 1,
        resourceKey: "o/r#1",
        installationId: 42,
        prSurface: fake.surface,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a".repeat(40),
        checkout: outcome === "not-needed" ? emptyCheckout(push) : checkout(push),
        inventory: [thread],
        resolutionByRootCommentId: new Map(),
        payload: { verdicts: [alreadyResolvedVerdict] },
        previouslyResolvedCount: 0,
      });

      expect(result).toEqual({ pushOutcome: outcome, missingThreadAction: true });
      expect(fake.controls.replies).toHaveLength(0);
      expect(resolveThreadIds(fake.controls)).toHaveLength(0);
      expect(upsertProgressBody(fake.controls)).toContain("could not be matched");
      if (outcome === "stale") {
        expect(upsertProgressBody(fake.controls)).toContain(TRIAGE_STALE_HEAD_NOTICE);
      } else {
        expect(upsertProgressBody(fake.controls)).not.toContain("head changed");
      }
    },
  );

  it("resumes a stored push without calling checkout.push", async () => {
    const fake = publishTestPrSurface();
    const push = vi.fn(async () => undefined);
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(push),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: { verdicts: [fixedVerdict] },
      previouslyResolvedCount: 0,
      priorPush: { pushOutcome: "pushed" },
    });

    expect(push).not.toHaveBeenCalled();
    expect(result).toEqual({ pushOutcome: "pushed", missingThreadAction: false });
    expect(fake.controls.replies).toHaveLength(1);
    expect(resolveThreadIds(fake.controls)).toContain("node");
    expect(upsertProgressBody(fake.controls)).toContain("Pushed commits:");
  });

  it("resumed not-needed does not resolve a fixed thread", async () => {
    const fake = publishTestPrSurface();
    const push = vi.fn(async () => undefined);
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: emptyCheckout(push),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: { verdicts: [fixedVerdict] },
      previouslyResolvedCount: 0,
      priorPush: { pushOutcome: "not-needed" },
    });

    expect(push).not.toHaveBeenCalled();
    expect(result).toEqual({ pushOutcome: "not-needed", missingThreadAction: false });
    expect(fake.controls.replies).toHaveLength(0);
    expect(resolveThreadIds(fake.controls)).toHaveLength(0);
  });

  it("skips already-resolved GitHub threads without degrading", async () => {
    const fake = publishTestPrSurface(new Map([[1, { threadNodeId: "node", isResolved: true }]]));
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => undefined),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: true }]]),
      payload: { verdicts: [alreadyResolvedVerdict] },
      previouslyResolvedCount: 1,
    });

    expect(result).toEqual({ pushOutcome: "pushed", missingThreadAction: false });
    expect(fake.controls.replies).toHaveLength(0);
    expect(resolveThreadIds(fake.controls)).toHaveLength(0);
  });

  it("does not remutate push on duplicate delivery after a reconciled intent", async () => {
    const firstPush = vi.fn(async () => undefined);
    const first = publishTestPrSurface();
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: first.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(firstPush),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: { verdicts: [fixedVerdict] },
      previouslyResolvedCount: 0,
    });
    expect(firstPush).toHaveBeenCalledTimes(1);

    const secondPush = vi.fn(async () => undefined);
    const second = publishTestPrSurface();
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: second.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(secondPush),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: { verdicts: [fixedVerdict] },
      previouslyResolvedCount: 0,
    });

    expect(secondPush).not.toHaveBeenCalled();
    expect(result).toEqual({ pushOutcome: "pushed", missingThreadAction: false });
    expect(memoryOperationIntentStore.get("wi", triagePushOperationKey("o/r#1"))?.status).toBe(
      "reconciled",
    );
  });

  it("does not treat an unknown push-intent outcome as a push result", async () => {
    await memoryOperationIntentStore.persist(pool(), {
      workItemId: "wi",
      operationKey: triagePushOperationKey("o/r#1"),
      mutationKind: "github.triage_push",
    });
    await memoryOperationIntentStore.reconcile(pool(), {
      workItemId: "wi",
      operationKey: triagePushOperationKey("o/r#1"),
      status: "outcome_unknown",
    });
    const push = vi.fn(async () => undefined);
    const fake = publishTestPrSurface();

    await expect(
      publishTriage({
        pool: pool(),
        workItemId: "wi",
        leaseEpoch: 1,
        resourceKey: "o/r#1",
        installationId: 42,
        prSurface: fake.surface,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "a".repeat(40),
        checkout: checkout(push),
        inventory: [thread],
        resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
        payload: { verdicts: [fixedVerdict] },
        previouslyResolvedCount: 0,
      }),
    ).rejects.toMatchObject({ code: "operation_intent.mutation_outcome_unknown" });
    expect(push).not.toHaveBeenCalled();
    expect(upsertProgressBody(fake.controls)).toBe("");
  });

  it("re-checks PR state after recover reconciles a landed push without calling checkout.push", async () => {
    await memoryOperationIntentStore.persist(pool(), {
      workItemId: "wi",
      operationKey: triagePushOperationKey("o/r#1"),
      mutationKind: "github.triage_push",
    });
    await memoryOperationIntentStore.reconcile(pool(), {
      workItemId: "wi",
      operationKey: triagePushOperationKey("o/r#1"),
      status: "outcome_unknown",
    });
    const push = vi.fn(async () => undefined);
    const fake = publishTestPrSurface();
    fake.controls.setPushedCommits([{ sha: "abcdef123456", subject: "fix: guard user" }]);
    fake.controls.setPullRequest({
      additions: 1,
      deletions: 0,
      changed_files: 1,
      state: "closed",
      merged: true,
      merged_at: "2026-01-01T00:00:00Z",
      head: { sha: "a".repeat(40) },
    });

    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(push),
      inventory: [thread],
      resolutionByRootCommentId: new Map([[1, { threadNodeId: "node", isResolved: false }]]),
      payload: { verdicts: [fixedVerdict] },
      previouslyResolvedCount: 0,
    });

    expect(push).not.toHaveBeenCalled();
    expect(memoryOperationIntentStore.get("wi", triagePushOperationKey("o/r#1"))?.status).toBe(
      "reconciled",
    );
    expect(result).toEqual({ pushOutcome: "closed", missingThreadAction: false });
    expect(fake.controls.replies).toHaveLength(0);
    expect(resolveThreadIds(fake.controls)).toHaveLength(0);
    const body = upsertProgressBody(fake.controls);
    expect(body).toContain(TRIAGE_CLOSED_PR_NOTICE);
    expect(body).not.toContain("Pushed commits:");
    expect(triagePushRecords()).toEqual([
      expect.objectContaining({ pushOutcome: "closed", attemptedShas: ["abcdef123456"] }),
    ]);
  });

  it("publishes a preview comment and records the triage_preview step", async () => {
    const fake = publishTestPrSurface();
    const hunks = [
      {
        threadRootCommentId: 1,
        subject: "fix: guard user",
        diff: "diff --git a/src/app.ts b/src/app.ts\n+ok\n",
      },
    ];

    await publishTriagePreview({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      inventory: [thread],
      previouslyResolvedCount: 0,
      hunks,
    });

    expect(upsertProgressBody(fake.controls)).toContain(TRIAGE_PREVIEW_SENTINEL);
    expect(upsertProgressBody(fake.controls)).toContain("```diff");
    expect(resolveThreadIds(fake.controls)).toHaveLength(0);
    expect(fake.controls.replies).toHaveLength(0);
    expect(recordPublishStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        step: "triage_preview",
        detail: {
          headSha: "a".repeat(40),
          threadRootCommentIds: [1],
          hunks,
        },
      }),
    );
  });

  it("marks a bulk run Partial when some findings apply and others fail", async () => {
    const fake = publishTestPrSurface();
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      leaseEpoch: 1,
      resourceKey: "o/r#1",
      installationId: 42,
      prSurface: fake.surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "a".repeat(40),
      checkout: checkout(async () => undefined),
      inventory: [thread, secondThread],
      resolutionByRootCommentId: new Map([
        [1, { threadNodeId: "node", isResolved: false }],
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
            verdict: "fixed",
            threadRootCommentId: 2,
            commitSha: "c".repeat(40),
            evidence: "fixed",
          },
        ],
      },
      previouslyResolvedCount: 0,
      bulkClassification: {
        excludedIds: new Set(),
        notInPreviewIds: new Set(),
        commitByThreadRootCommentId: new Map([[1, "abcdef123456"]]),
        commitErrors: [{ threadRootCommentId: 2 }],
      },
    });

    expect(result.partialBulk).toBe(true);
    expect(upsertProgressBody(fake.controls)).toContain(TRIAGE_BULK_PARTIAL_NOTICE);
    expect(upsertProgressBody(fake.controls)).toContain("applied");
    expect(upsertProgressBody(fake.controls)).toContain("failed");
  });
});
