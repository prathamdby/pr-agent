import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { createOperationLogger } from "../src/evlog.js";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { ACK_QUEUE } from "../src/agentWork/types.js";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/askSafety.js";
import { ASK_QUESTION_TOO_LONG_HINT, ASK_USAGE_HINT } from "../src/commands/parseAskQuestion.js";
import * as postgres from "../src/db/postgres.js";

function makeSlashInput(body: string) {
  return {
    headers: { event: "issue_comment", delivery: "d1", rawBody: Buffer.from("{}") },
    installationId: 42,
    owner: "acme",
    repo: "app",
    prNumber: 7,
    commentId: 99,
    commenterId: 1,
    body,
    replyTarget: { kind: "prConversation" as const },
  };
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
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);

    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput(`/ask ${long}`), intakeLog),
    );

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation" },
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
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const pool = {} as Pool;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler(pool, boss);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/ask"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation" },
      body: ASK_USAGE_HINT,
    });
  });
});
