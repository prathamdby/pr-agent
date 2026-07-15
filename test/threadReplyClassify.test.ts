import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { makeTestConfig } from "./helpers/config.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  IGNORED_BOT_SLASH_COMMAND,
  IGNORED_NON_BOT_THREAD_REPLY,
  THREAD_REPLY_ASK_ENQUEUED,
  THREAD_REPLY_CLASSIFICATION_FAILED,
  THREAD_REPLY_CLASSIFICATION_QUEUED,
  THREAD_REPLY_CLASSIFY_QUEUE,
} from "../src/settings/index.js";
import type { ThreadReplyClassifyJobData } from "../src/agentWork/types.js";
import * as postgres from "../src/db/postgres.js";

const mocks = vi.hoisted(() => ({
  getAppBotIdentity: vi.fn(),
  mintInstallationAuth: vi.fn(),
  getPullRequestReviewComment: vi.fn(),
  hasStoredInlineReviewId: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/appAuth.js")>();
  return {
    ...actual,
    getAppBotIdentity: mocks.getAppBotIdentity,
    mintInstallationAuth: mocks.mintInstallationAuth,
  };
});

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  return {
    ...actual,
    getPullRequestReviewComment: mocks.getPullRequestReviewComment,
  };
});

vi.mock("../src/agentWork/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/repository.js")>();
  return {
    ...actual,
    hasStoredInlineReviewId: mocks.hasStoredInlineReviewId,
  };
});

import { executeThreadReplyClassifyJob } from "../src/agentWork/executors/threadReplyClassifyExecutor.js";
import { applyThreadReplyClassifyIntake } from "../src/agentWork/intake/threadReplyClassifyIntake.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { Effect } from "effect";
import { createOperationLogger } from "../src/evlog.js";

const cfg = makeTestConfig({ enableThreadReplies: true });

function baseJobData(
  overrides: Partial<ThreadReplyClassifyJobData> = {},
): ThreadReplyClassifyJobData {
  return {
    kind: "thread_reply_classify",
    webhookEventId: "event-1",
    delivery: "d1",
    installationId: 9,
    owner: "acme",
    repo: "app",
    prNumber: 7,
    commentId: 101,
    commenterId: 7,
    authorAssociation: "MEMBER",
    body: "why is this P1?",
    replyTarget: {
      kind: "inlineReviewThread",
      prNumber: 7,
      inReplyToCommentId: 100,
    },
    inReplyToCommentId: 100,
    pullRequestReviewId: 55,
    storedReviewMatchHint: false,
    ...overrides,
  };
}

function makeJob(
  data: ThreadReplyClassifyJobData,
  retryCount = 0,
  retryLimit = 3,
): JobWithMetadata<ThreadReplyClassifyJobData> {
  return {
    id: "job-1",
    name: THREAD_REPLY_CLASSIFY_QUEUE,
    data,
    retryCount,
    retryLimit,
  } as JobWithMetadata<ThreadReplyClassifyJobData>;
}

describe("thread reply classify intake", () => {
  it("inserts webhook event and enqueues classify without GitHub calls", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;

    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    await applyThreadReplyClassifyIntake(
      boss,
      client,
      {
        headers: {
          event: "pull_request_review_comment",
          delivery: "d1",
          rawBody: Buffer.from("{}"),
        },
        installationId: 9,
        owner: "acme",
        repo: "app",
        prNumber: 7,
        commentId: 101,
        commenterId: 7,
        authorAssociation: "MEMBER",
        body: "why?",
        replyTarget: {
          kind: "inlineReviewThread",
          prNumber: 7,
          inReplyToCommentId: 100,
        },
        inReplyToCommentId: 100,
        pullRequestReviewId: 55,
        storedReviewMatchHint: true,
      },
      createOperationLogger({ method: "POST", path: "/webhooks" }),
    );

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO webhook_events"),
      expect.arrayContaining([THREAD_REPLY_CLASSIFICATION_QUEUED]),
    );
    expect(sentJobs).toEqual([
      expect.objectContaining({
        queue: THREAD_REPLY_CLASSIFY_QUEUE,
        data: expect.objectContaining({
          kind: "thread_reply_classify",
          webhookEventId: "event-1",
          storedReviewMatchHint: true,
        }),
      }),
    ]);
    expect(mocks.mintInstallationAuth).not.toHaveBeenCalled();
    expect(mocks.getPullRequestReviewComment).not.toHaveBeenCalled();
    expect(mocks.getAppBotIdentity).not.toHaveBeenCalled();
  });

  it("scheduler lookupStoredInlineReviewHint is DB-only", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(true);
    const pool = {} as Pool;
    const boss = {} as PgBoss;
    const scheduler = makeAgentWorkScheduler(pool, boss, cfg);
    const hint = await Effect.runPromise(
      scheduler.lookupStoredInlineReviewHint("acme", "app", 7, 55),
    );
    expect(hint).toBe(true);
    expect(mocks.hasStoredInlineReviewId).toHaveBeenCalled();
    expect(mocks.mintInstallationAuth).not.toHaveBeenCalled();
  });
});

describe("executeThreadReplyClassifyJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 42, login: "pr-agent[bot]" });
    mocks.mintInstallationAuth.mockResolvedValue({
      token: "t",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    mocks.getPullRequestReviewComment.mockResolvedValue({
      userId: 42,
      pullRequestReviewId: 55,
    });
    mocks.hasStoredInlineReviewId.mockResolvedValue(false);
  });

  it("skips review-record and GitHub parent lookup when stored hint is true", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(false);
    const decisions: string[] = [];
    const sentQueues: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("UPDATE webhook_events")) {
          decisions.push(String(params?.[1]));
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "ask-1" }] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = {
      send: vi.fn(async (queue: string) => {
        sentQueues.push(queue);
        return "jid";
      }),
    } as unknown as PgBoss;

    await executeThreadReplyClassifyJob(
      cfg,
      pool,
      boss,
      makeJob(baseJobData({ storedReviewMatchHint: true, pullRequestReviewId: 55 })),
    );

    expect(mocks.hasStoredInlineReviewId).not.toHaveBeenCalled();
    expect(mocks.getPullRequestReviewComment).not.toHaveBeenCalled();
    expect(mocks.mintInstallationAuth).not.toHaveBeenCalled();
    expect(sentQueues).toEqual([ACK_QUEUE, ASK_QUEUE]);
    expect(decisions).toEqual([THREAD_REPLY_ASK_ENQUEUED]);
  });

  it("enqueues ack and ask when createAskWorkItem returns created:false while queued", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(true);
    const decisions: string[] = [];
    const sentQueues: string[] = [];
    const sendOptions: unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("UPDATE webhook_events")) {
          decisions.push(String(params?.[1]));
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT id") && sql.includes("agent_work_items")) {
          return { rows: [{ id: "ask-existing" }] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>, options?: unknown) => {
        sentQueues.push(queue);
        sendOptions.push(options);
        if (queue === ASK_QUEUE) {
          expect(data.workItemId).toBe("ask-existing");
        }
        if (queue === ACK_QUEUE) {
          expect(data.workItemId).toBe("ask-existing");
        }
        return "jid";
      }),
    } as unknown as PgBoss;

    await executeThreadReplyClassifyJob(
      cfg,
      {} as Pool,
      boss,
      makeJob(baseJobData({ pullRequestReviewId: 55 })),
    );

    expect(sentQueues).toEqual([ACK_QUEUE, ASK_QUEUE]);
    expect(decisions).toEqual([THREAD_REPLY_ASK_ENQUEUED]);
    expect(sendOptions).toEqual([
      expect.objectContaining({ singletonKey: "ask-ack:event-1" }),
      expect.objectContaining({ singletonKey: "ask:ask-existing" }),
    ]);
  });

  it("treats singleton-null ask enqueue as idempotent success on recover", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(true);
    const decisions: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("UPDATE webhook_events")) {
          decisions.push(String(params?.[1]));
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [] };
        }
        if (sql.includes("SELECT id") && sql.includes("agent_work_items")) {
          return { rows: [{ id: "ask-existing" }] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = {
      send: vi.fn(async () => null),
    } as unknown as PgBoss;

    await executeThreadReplyClassifyJob(
      cfg,
      {} as Pool,
      boss,
      makeJob(baseJobData({ pullRequestReviewId: 55 })),
    );

    expect(boss.send).toHaveBeenCalledTimes(2);
    expect(decisions).toEqual([THREAD_REPLY_ASK_ENQUEUED]);
  });

  it("throws when webhook event is missing during promotion", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(true);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FOR UPDATE")) {
          return { rows: [] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = { send: vi.fn() } as unknown as PgBoss;

    await expect(
      executeThreadReplyClassifyJob(
        cfg,
        {} as Pool,
        boss,
        makeJob(baseJobData({ pullRequestReviewId: 55 })),
      ),
    ).rejects.toThrow(/webhook event event-1 missing/);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("marks ignored_bot_slash_command for bot commenter", async () => {
    const decisions: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("UPDATE webhook_events")) {
          decisions.push(String(params?.[1]));
          return { rows: [] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = { send: vi.fn() } as unknown as PgBoss;

    await executeThreadReplyClassifyJob(cfg, pool, boss, makeJob(baseJobData({ commenterId: 42 })));

    expect(decisions).toEqual([IGNORED_BOT_SLASH_COMMAND]);
    expect(boss.send).not.toHaveBeenCalled();
    expect(mocks.getPullRequestReviewComment).not.toHaveBeenCalled();
  });

  it("marks ignored_non_bot_thread_reply when parent is not bot", async () => {
    mocks.getPullRequestReviewComment.mockResolvedValue({
      userId: 99,
      pullRequestReviewId: null,
    });
    const decisions: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("UPDATE webhook_events")) {
          decisions.push(String(params?.[1]));
          return { rows: [] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    await executeThreadReplyClassifyJob(
      cfg,
      {} as Pool,
      { send: vi.fn() } as unknown as PgBoss,
      makeJob(baseJobData()),
    );

    expect(decisions).toEqual([IGNORED_NON_BOT_THREAD_REPLY]);
  });

  it("retries on GitHub API failure and terminalizes on last attempt", async () => {
    mocks.getPullRequestReviewComment.mockRejectedValue(new Error("github down"));
    const decisions: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("UPDATE webhook_events")) {
          decisions.push(String(params?.[1]));
          return { rows: [] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    await expect(
      executeThreadReplyClassifyJob(
        cfg,
        {} as Pool,
        { send: vi.fn() } as unknown as PgBoss,
        makeJob(baseJobData(), 0, 3),
      ),
    ).rejects.toThrow("github down");
    expect(decisions).toEqual([]);

    await expect(
      executeThreadReplyClassifyJob(
        cfg,
        {} as Pool,
        { send: vi.fn() } as unknown as PgBoss,
        makeJob(baseJobData(), 3, 3),
      ),
    ).rejects.toThrow("github down");
    expect(decisions).toEqual([THREAD_REPLY_CLASSIFICATION_FAILED]);
  });

  it("is idempotent when decision is already terminal", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(true);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_ASK_ENQUEUED }],
          };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = { send: vi.fn() } as unknown as PgBoss;

    await executeThreadReplyClassifyJob(
      cfg,
      {} as Pool,
      boss,
      makeJob(baseJobData({ pullRequestReviewId: 55 })),
    );

    expect(boss.send).not.toHaveBeenCalled();
  });

  it("rolls back when ask enqueue throws after work item insert", async () => {
    mocks.hasStoredInlineReviewId.mockResolvedValue(true);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{ id: "event-1", processing_decision: THREAD_REPLY_CLASSIFICATION_QUEUED }],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "ask-1" }] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 100)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));
    const boss = {
      send: vi.fn(async (queue: string) => {
        if (queue === ASK_QUEUE) throw new Error("ask queue unavailable");
        return "jid";
      }),
    } as unknown as PgBoss;

    await expect(
      executeThreadReplyClassifyJob(
        cfg,
        {} as Pool,
        boss,
        makeJob(baseJobData({ pullRequestReviewId: 55 })),
      ),
    ).rejects.toThrow(/ask queue unavailable/);
  });
});
