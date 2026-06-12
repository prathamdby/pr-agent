import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { makeAgentWorkScheduler } from "../src/agentWork/scheduler.js";
import { createOperationLogger, initEvlog } from "../src/evlog.js";
import { ACK_QUEUE, SLASH_HELP_BODY } from "../src/settings/index.js";
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

    const scheduler = makeAgentWorkScheduler({} as Pool, boss);
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

    const scheduler = makeAgentWorkScheduler({} as Pool, boss);
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
});
