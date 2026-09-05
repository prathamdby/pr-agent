import { describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
const intakeCfg = makeTestConfig();
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { createOperationLogger } from "../src/evlog.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  ASK_USAGE_HINT,
  MAX_ASK_QUESTION_CHARS,
} from "../src/settings/index.js";
import { ASK_QUESTION_TOO_LONG_HINT } from "../src/commands/parseAskQuestion.js";
import * as postgres from "../src/db/postgres.js";

function makeSlashInput(body: string) {
  const command = body.slice(1).split(/\s+/, 1)[0] ?? "";
  return {
    headers: {
      event: "issue_comment",
      delivery: "d1",
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

function askQuotaQuery(sql: string, params?: unknown[]) {
  if (sql.includes("INSERT INTO ask_quota_buckets")) return { rows: [] };
  if (sql.includes("FROM ask_quota_buckets") && sql.includes("FOR UPDATE")) {
    return {
      rows: [
        {
          scope: params?.[0],
          scope_key: params?.[1],
          token_balance: 100,
          last_refill_at: new Date(),
          outstanding_count: 0,
          provider_tokens_used: 0,
          provider_tokens_reserved: 0,
          provider_window_started_at: new Date(),
        },
      ],
    };
  }
  if (sql.includes("UPDATE ask_quota_buckets")) return { rows: [], rowCount: 1 };
  if (sql.includes("INSERT INTO ask_quota_reservations")) return { rows: [], rowCount: 1 };
  return undefined;
}

describe("makeAgentWorkScheduler /ask slash", () => {
  it("enqueues too-long hint ack without ask work", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;

    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);

    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput(`/ask ${long}`), intakeLog),
    );

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: ASK_QUESTION_TOO_LONG_HINT,
    });
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it("enqueues usage hint ack for bare /ask", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;

    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/ask"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: ASK_USAGE_HINT,
    });
  });

  it("enqueues ask work for @mention on inline review threads", async () => {
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
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        const quotaResult = askQuotaQuery(sql, params);
        if (quotaResult) return quotaResult;
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "ask-work-1" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(
      scheduler.submitSlashCommand(
        {
          headers: {
            event: "pull_request_review_comment",
            delivery: "d-thread-reply",
            rawBody: Buffer.from("{}"),
          },
          installationId: 42,
          owner: "acme",
          repo: "app",
          prNumber: 7,
          commentId: 101,
          commenterId: 1,
          body: "@pr-agent[bot] why is this P1?",
          command: "ask",
          botLogin: "pr-agent[bot]",
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 7,
            inReplyToCommentId: 100,
          },
        },
        intakeLog,
      ),
    );

    expect(workItemInserts).toHaveLength(1);
    expect(sentJobs.map((j) => j.queue)).toContain(ASK_QUEUE);
    expect(sentJobs.find((j) => j.queue === ACK_QUEUE)?.data.reply).toBeUndefined();
  });
});
