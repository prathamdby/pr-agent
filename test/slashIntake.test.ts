import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
const intakeCfg = makeTestConfig();
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { createOperationLogger, initEvlog } from "../src/evlog.js";
import {
  ACK_QUEUE,
  DESCRIPTION_ALREADY_IN_PROGRESS,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  SLASH_HELP_BODY,
  TRIAGE_QUEUE,
} from "../src/settings/index.js";
import * as postgres from "../src/db/postgres.js";

function makeSlashInput(body: string) {
  const command = body.slice(1).split(/\s+/, 1)[0] ?? "";
  return {
    headers: {
      event: "issue_comment",
      delivery: `d-${command}`,
      rawBody: Buffer.from("{}"),
    },
    installationId: 42,
    owner: "acme",
    repo: "app",
    prNumber: 7,
    commentId: 99,
    commenterId: 1,
    body,
    command,
    replyTarget: { kind: "prConversation" as const, prNumber: 7 },
  };
}

function makeClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    }),
  } as unknown as PoolClient;
}

describe("applySlashCommandIntake", () => {
  beforeEach(() => {
    initEvlog("info", { silent: true, suppressDrainWarning: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("records unknown slash commands without acking", async () => {
    const boss = { send: vi.fn() } as unknown as PgBoss;
    const client = makeClient();
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/cc looks good"), intakeLog),
    );

    expect(boss.send).not.toHaveBeenCalled();
    expect(intakeLog.getContext().events).toEqual([
      expect.objectContaining({
        event: "ignored_unknown_slash_command",
        command: "cc",
      }),
    ]);
  });

  it("still replies to help", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = makeClient();
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/help"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: SLASH_HELP_BODY,
    });
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "ignored_unknown_slash_command" }),
    );
  });

  it("enqueues a review work item with the review-tests lens", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const workItemInserts: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        if (sql.includes("SELECT id")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-review-tests" }] };
        }
        if (sql.includes("INSERT INTO publish_records")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/review-tests"), intakeLog),
    );

    expect(workItemInserts).toHaveLength(1);
    expect(workItemInserts[0]).toContain("review-tests");
    expect(sentJobs.map((j) => j.queue)).toContain(REVIEW_QUEUE);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_enqueued",
        type: "review",
        lens: "review-tests",
      }),
    );
  });

  it("enqueues a triage work item and ack", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const workItemInserts: unknown[][] = [];
    let workItemInsertSql = "";
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SELECT id, payload")) return { rows: [] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInsertSql = sql;
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/triage"), intakeLog));

    expect(workItemInserts).toHaveLength(1);
    expect(workItemInserts[0]).toContain("triage");
    expect(workItemInsertSql).toContain("ON CONFLICT");
    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, TRIAGE_QUEUE]);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_enqueued",
        type: "triage",
      }),
    );
  });

  it("dedups an active triage work item", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [] };
        if (sql.includes("SELECT id, payload")) {
          return {
            rows: [
              {
                id: "active",
                payload: {
                  source: "slash",
                  commentId: 99,
                  scope: "all",
                  replyTarget: { kind: "prConversation", prNumber: 7 },
                },
              },
            ],
          };
        }
        if (sql.includes("SELECT id")) return { rows: [{ id: "active" }] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/triage"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.reply).toMatchObject({
      target: { kind: "prConversation", prNumber: 7 },
    });
  });

  it("acks full-run-in-progress when a thread /triage arrives during full triage", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [] };
        if (sql.includes("SELECT id, payload")) {
          return {
            rows: [
              {
                id: "active",
                payload: {
                  source: "slash",
                  commentId: 99,
                  scope: "all",
                  replyTarget: { kind: "prConversation", prNumber: 7 },
                },
              },
            ],
          };
        }
        if (sql.includes("SELECT id")) return { rows: [{ id: "active" }] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitSlashCommand(
        {
          ...makeSlashInput("/triage"),
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 7,
            inReplyToCommentId: 50,
          },
          triageScope: "thread",
          threadAnchorCommentId: 50,
          needsThreadRootResolution: true,
        },
        intakeLog,
      ),
    );

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.data.reply).toMatchObject({
      target: { kind: "inlineReviewThread", prNumber: 7, inReplyToCommentId: 50 },
    });
    expect(String((sentJobs[0]?.data.reply as { body?: string }).body)).toContain("full-PR");
  });

  it("stores triage scope in the work item payload", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const workItemInserts: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SELECT id, payload")) return { rows: [] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage-scope" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitSlashCommand(
        {
          ...makeSlashInput("/triage"),
          triageScope: "all",
        },
        intakeLog,
      ),
    );

    const payload = JSON.parse(String(workItemInserts[0]?.at(-1)));
    expect(payload.scope).toBe("all");
    expect(payload.needsThreadRootResolution).toBeUndefined();
    expect(payload.replyTarget).toEqual({ kind: "prConversation", prNumber: 7 });
    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, TRIAGE_QUEUE]);
  });

  it("acks already-in-progress when slash review create loses the uniqueness race", async () => {
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
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [] };
        }
        if (sql.includes("staleHeadRescheduled")) {
          return { rows: [{ id: "winner-review" }] };
        }
        if (sql.includes("SELECT id") && sql.includes("review_lens")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/review"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.progress).toBeUndefined();
    expect(sentJobs[0]?.data.workItemId).toBeUndefined();
    expect(String((sentJobs[0]?.data.reply as { body?: string }).body)).toContain("already queued");
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "agent_work_enqueued" }),
    );
  });

  it("acks already-in-progress when slash describe create loses the uniqueness race", async () => {
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
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [] };
        }
        if (sql.includes("type = 'description'")) {
          return { rows: [] };
        }
        if (sql.includes("source = 'slash'")) {
          return { rows: [{ id: "winner-describe" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/describe"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs.map((j) => j.queue)).not.toContain(DESCRIPTION_QUEUE);
    expect(sentJobs[0]?.data.progress).toBeUndefined();
    expect(sentJobs[0]?.data.workItemId).toBeUndefined();
    expect(String((sentJobs[0]?.data.reply as { body?: string }).body)).toBe(
      DESCRIPTION_ALREADY_IN_PROGRESS,
    );
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "agent_work_enqueued" }),
    );
  });
});
