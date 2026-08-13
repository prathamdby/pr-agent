import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  StaleHeadPushError,
  type WritablePrCheckout,
} from "../src/prWorkspace/writablePrCheckout.js";

import {
  publishTestPrSurface,
  resolveThreadIds,
  upsertProgressBody,
} from "./helpers/publishPrSurface.js";
import { publishTriage, publishTriageReportOnly } from "../src/agent/triage/publishTriage.js";
import { TRIAGE_SUMMARY_SENTINEL } from "../src/settings/index.js";
import * as repo from "../src/agentWork/repository.js";
import * as workItemState from "../src/agentWork/workItemStateRepository.js";
import * as triageAnalytics from "../src/agentWork/triageAnalytics.js";
import type { JsonValue } from "../src/util/jsonValue.js";
import type { QueryResult, QueryResultRow } from "pg";

function unusedQueryResult(rows: QueryResultRow[]): QueryResult {
  return {
    rows,
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

function pool(detail?: JsonValue): Pool {
  const client = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
  vi.spyOn(client, "query").mockImplementation(async () =>
    unusedQueryResult(detail === undefined ? [] : [{ detail }]),
  );
  return client;
}

function poolWithPriorRunActedIds(): Pool {
  const client = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
  vi.spyOn(client, "query").mockImplementation(async (_sql, args?: readonly JsonValue[]) =>
    unusedQueryResult(args?.[0] === "wi" ? [] : [{ detail: { actedThreadIds: [1] } }]),
  );
  return client;
}

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

describe("publishTriage", () => {
  let controls: import("../src/github/fakePrSurface.js").FakePrSurfaceControls;

  beforeEach(() => {
    vi.spyOn(repo, "recordPublishStep").mockResolvedValue(undefined);
    vi.spyOn(workItemState, "assertCurrentExecutionEpoch").mockResolvedValue(undefined);
    vi.spyOn(workItemState, "isExecutionEpochCurrent").mockResolvedValue(true);
    vi.spyOn(triageAnalytics, "captureTriageEvent").mockImplementation(() => undefined);
    vi.spyOn(triageAnalytics, "captureTriageFailure").mockImplementation(() => undefined);
    controls = publishTestPrSurface().controls;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts no thread replies when push is stale", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      executionEpoch: 1,
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

    expect(result.degraded).toBe(true);
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
    expect(upsertProgressBody(controls)).toContain("head changed");
  });

  it("replies and resolves a fixed thread after a successful push", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    const result = await publishTriage({
      pool: pool(),
      workItemId: "wi",
      executionEpoch: 1,
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

    expect(result.degraded).toBe(false);
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.body).toContain("Fixed in");
    expect(resolveThreadIds(controls)).toContain("node");
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
      executionEpoch: 1,
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

    expect(result.degraded).toBe(true);
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
      executionEpoch: 1,
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
      executionEpoch: 1,
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

    expect(result.degraded).toBe(true);
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toContain("node");
  });

  it("does not resolve skipped threads", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      executionEpoch: 1,
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
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      executionEpoch: 1,
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

    expect(push).not.toHaveBeenCalled();
    expect(controls.replies).toHaveLength(1);
    expect(controls.replies[0]?.target).toEqual(
      expect.objectContaining({ kind: "inlineReviewThread", inReplyToCommentId: 2 }),
    );
    expect(resolveThreadIds(controls)).toEqual(expect.arrayContaining(["node-1", "node-2"]));
  });

  it("does not resolve a fixed thread when the checkout has no commits", async () => {
    const push = vi.fn(async () => undefined);
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool(),
      workItemId: "wi",
      executionEpoch: 1,
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

    expect(push).not.toHaveBeenCalled();
    expect(controls.replies).toHaveLength(0);
    expect(resolveThreadIds(controls)).toHaveLength(0);
  });

  it("skips duplicate replies but still resolves already acted threads", async () => {
    const fake = publishTestPrSurface();
    controls = fake.controls;
    await publishTriage({
      pool: pool({ actedThreadIds: [1] }),
      workItemId: "wi",
      executionEpoch: 1,
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
      executionEpoch: 1,
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
      executionEpoch: 1,
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
      executionEpoch: 1,
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

    expect(result.degraded).toBe(true);
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
      executionEpoch: 1,
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
      executionEpoch: 1,
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
      executionEpoch: 1,
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
