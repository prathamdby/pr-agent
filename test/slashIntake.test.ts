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
  TRIAGE_INVALID_EXCLUDE,
  TRIAGE_QUEUE,
  TRIAGE_UNKNOWN_SUBCOMMAND,
  VERIFICATION_QUEUE,
} from "../src/settings/index.js";
import * as postgres from "../src/db/postgres.js";

vi.mock("../src/agentWork/intake/reviewApprovals.js", () => ({
  approveAwaiting: async () => null,
}));

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
    commenterLogin: "alice",
    body,
    command,
    replyTarget: { kind: "prConversation" as const, prNumber: 7 },
  };
}

function makeClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO webhook_event_replays")) {
        return { rows: [{ body_sha256: "hash" }] };
      }
      if (sql.includes("INSERT INTO webhook_events")) {
        return { rows: [{ id: "event-1" }] };
      }
      if (sql.includes("pr_actor_leases")) return { rows: [] };
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

  it("replies to unknown slash commands", async () => {
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

    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/cc looks good"), intakeLog),
    );

    expect(sentJobs).toEqual([
      expect.objectContaining({
        queue: ACK_QUEUE,
        data: expect.objectContaining({
          reply: {
            target: { kind: "prConversation", prNumber: 7 },
            body: "Unknown command `/cc`. Run `/help` for available commands.",
          },
        }),
      }),
    ]);
    expect(intakeLog.getContext().events).toEqual([
      expect.objectContaining({
        event: "ignored_unknown_slash_command",
        command: "cc",
      }),
    ]);
  });

  it("still replies to help", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown>; options?: unknown }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>, options?: unknown) => {
        sentJobs.push({ queue, data, options });
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
    expect(sentJobs[0]?.options).toEqual(expect.objectContaining({ priority: 100 }));
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: [
        "### PR Agent help",
        "",
        "Commands (first line of a **new** comment):",
        "- `/help` - show this message",
        "- `/ask <question>` - ask about this PR or a specific line (or mention the App bot for the same Q&A)",
        "- `/describe` - write the PR Agent description block (also runs when a PR opens). Title rewrite is on by default; set FEATURE_TITLE_REWRITE=false to keep the existing title",
        "- `/review` - review the PR for bugs (also runs when a PR opens in `auto`, or in `approval` mode for trusted authors and after maintainer approval for forks)",
        "- `/review force` - cancel any queued or in-progress review and start a new one on the latest commit",
        "- `/cancel` - cancel a queued or in-progress review on this PR",
        "- `/triage` - fix earlier PR Agent findings on this PR. Post on the conversation for all findings, or reply `/triage` inside one finding thread for that finding only.",
        "- `/triage preview` - render the would-be unified diff for eligible findings. No commits, no push.",
        "- `/triage all` - apply the previewed set (one commit per finding). Optional `exclude <thread ids>`. Refused without a matching `/triage preview` on this head.",
        "- `/verify` - verify open findings against the current pull request head",
        "",
        "Notes:",
        "- What runs automatically depends on the `FEATURE_*` settings (see docs/features.md). Review and describe fire on PR open in `auto` mode; later pushes need a manual `/review`.",
        "- `/describe` writes in the PR Agent description block and keeps your text outside it.",
        "- `/ask` and App-bot mentions read the containing thread so follow-ups stay in conversation. They do not change finding severity or dismiss threads.",
        "- `/cancel` stops the active review immediately and updates the progress stub with who cancelled it.",
        "- Edited comments are ignored for slash parsing in v1.",
      ].join("\n"),
    });
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "ignored_unknown_slash_command" }),
    );
  });

  it("routes removed review lens commands to the unknown-command reply", async () => {
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

    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/review-security"), intakeLog),
    );

    expect(sentJobs).toEqual([
      expect.objectContaining({
        queue: ACK_QUEUE,
        data: expect.objectContaining({
          reply: {
            target: { kind: "prConversation", prNumber: 7 },
            body: "Unknown command `/review-security`. Run `/help` for available commands.",
          },
        }),
      }),
    ]);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "ignored_unknown_slash_command",
        command: "review-security",
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
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SELECT id, payload")) return { rows: [] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInsertSql = sql;
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
    const applyPayload = JSON.parse(String(workItemInserts[0]?.at(-1)));
    expect(applyPayload.mode).toBeUndefined();
  });

  it("acks an unknown /triage subcommand without creating a work item", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/triage all extra"), intakeLog),
    );

    expect(workItemInserts).toHaveLength(0);
    expect(sentJobs).toEqual([
      expect.objectContaining({
        queue: ACK_QUEUE,
        data: expect.objectContaining({
          reply: expect.objectContaining({ body: TRIAGE_UNKNOWN_SUBCOMMAND }),
        }),
      }),
    ]);
  });

  it("acks invalid /triage all exclude without creating a work item", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/triage all exclude abc"), intakeLog),
    );

    expect(workItemInserts).toHaveLength(0);
    expect(sentJobs).toEqual([
      expect.objectContaining({
        queue: ACK_QUEUE,
        data: expect.objectContaining({
          reply: expect.objectContaining({ body: TRIAGE_INVALID_EXCLUDE }),
        }),
      }),
    ]);
  });

  it("enqueues /triage preview with mode on the payload", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const payloads: unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          payloads.push(JSON.parse(String(params?.at(-1))));
          return { rows: [{ id: "work-triage", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/triage preview"), intakeLog),
    );

    expect(payloads).toEqual([expect.objectContaining({ mode: "preview" })]);
    expect(sentJobs.map((job) => job.queue)).toEqual([ACK_QUEUE, TRIAGE_QUEUE]);
  });

  it("enqueues /triage all exclude with bulk mode and ids", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const payloads: unknown[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          payloads.push(JSON.parse(String(params?.at(-1))));
          return { rows: [{ id: "work-triage", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/triage all exclude 11,22"), intakeLog),
    );

    expect(payloads).toEqual([
      expect.objectContaining({
        mode: "bulk",
        excludeThreadRootCommentIds: [11, 22],
      }),
    ]);
    expect(sentJobs.map((job) => job.queue)).toEqual([ACK_QUEUE, TRIAGE_QUEUE]);
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
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "active", created: false }] };
        }
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
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "active", created: false }] };
        }
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
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SELECT id, payload")) return { rows: [] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage-scope", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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

  it("enqueues /triage all as bulk with full-PR scope and exclude ids", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SELECT id, payload")) return { rows: [] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-triage-bulk", created: true }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
          ...makeSlashInput("/triage all exclude 11,22"),
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 7,
            inReplyToCommentId: 50,
          },
          triageScope: "thread",
          threadAnchorCommentId: 50,
        },
        intakeLog,
      ),
    );

    const payload = JSON.parse(String(workItemInserts[0]?.at(-1)));
    expect(payload.mode).toBe("bulk");
    expect(payload.scope).toBe("all");
    expect(payload.excludeThreadRootCommentIds).toEqual([11, 22]);
    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, TRIAGE_QUEUE]);
  });

  it("enqueues /review without inspecting or mutating pg-boss jobs", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "work-review", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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

    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, REVIEW_QUEUE]);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_enqueued",
        type: "review",
      }),
    );
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
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "winner-review", created: false }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) {
          return { rows: [{ id: "event-1" }] };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "winner-describe", created: false }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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

  it("acks when /cancel finds no active review", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SET status = 'cancelled'")) return { rows: [] };
        if (sql.includes("SET cancel_requested_at")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/cancel"), intakeLog));

    expect(sentJobs).toEqual([
      expect.objectContaining({
        queue: ACK_QUEUE,
        data: expect.objectContaining({
          reply: {
            target: { kind: "prConversation", prNumber: 7 },
            body: "No review is queued or in progress for this pull request.",
          },
        }),
      }),
    ]);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "ignored_slash_cancel_no_active_review",
      }),
    );
  });

  it("cancels an active review and enqueues cancelProgress ack", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return { rows: [] };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-review",
                source: "slash",
                head_sha: "abc123",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/cancel"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: "Cancelled the in-progress review.",
    });
    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-review",
      cancelledWorkItemIds: ["wi-review"],
      attribution: { kind: "user", login: "alice" },
    });
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_cancel_requested",
        type: "review",
        cancelledByLogin: "alice",
      }),
    );
  });

  it("prefers a running review as cancelProgress primary over queued", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          expect(sql).toContain("last_error");
          expect(sql).toContain("completed_at");
          return {
            rows: [
              {
                id: "wi-queued",
                source: "auto",
                head_sha: "queued-sha",
                created_at: "2026-01-01T00:00:02Z",
              },
            ],
          };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          expect(sql).toContain("COALESCE(cancel_requested_at");
          expect(sql).toContain("last_error");
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "running-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/cancel"), intakeLog));

    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running", "wi-queued"],
      attribution: { kind: "user", login: "alice" },
    });
    const attributionPatch = JSON.stringify({
      cancelAttribution: { kind: "user", login: "alice" },
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'queued'"), [
      "acme/app#7",
      "Cancelled by slash /cancel",
      attributionPatch,
    ]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      "acme/app#7",
      "Cancelled by slash /cancel",
      attributionPatch,
    ]);
  });

  it("force-restarts an active review on /review force", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return { rows: [] };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "old-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "wi-new", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/review force"), intakeLog),
    );

    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, REVIEW_QUEUE]);
    const ack = sentJobs[0]?.data;
    expect(ack?.workItemId).toBe("wi-new");
    expect(ack?.progress).toBeDefined();
    expect(ack?.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running"],
      attribution: { kind: "user", login: "alice" },
    });
    expect(ack?.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: "Cancelled the previous review and started a new one on the latest commit.",
    });
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_cancel_requested",
        type: "review",
        force: true,
        cancelledByLogin: "alice",
      }),
    );
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_enqueued",
        type: "review",
        force: true,
      }),
    );
  });

  it("treats /review force with no active review like a plain /review", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SET status = 'cancelled'")) return { rows: [] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "wi-new", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/review force"), intakeLog),
    );

    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, REVIEW_QUEUE]);
    const ack = sentJobs[0]?.data;
    expect(ack?.workItemId).toBe("wi-new");
    expect(ack?.progress).toBeDefined();
    expect(ack?.cancelProgress).toBeUndefined();
    expect(ack?.reply).toBeUndefined();
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "agent_work_cancel_requested" }),
    );
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_enqueued",
        type: "review",
        force: true,
      }),
    );
  });

  it("keeps check-run cleanup when /review force loses the uniqueness race", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return { rows: [] };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "old-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "winner-review", created: false }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
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
      scheduler.submitSlashCommand(makeSlashInput("/review force"), intakeLog),
    );

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running"],
      attribution: { kind: "user", login: "alice" },
    });
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: "A `/review` run is already queued or in progress for this pull request.",
    });
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({ event: "agent_work_cancel_requested", force: true }),
    );
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "agent_work_enqueued" }),
    );
  });

  it("force with queued and running rows cancels both with the running row as primary", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-queued",
                source: "auto",
                head_sha: "queued-sha",
                created_at: "2026-01-01T00:00:02Z",
              },
            ],
          };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "running-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "wi-new", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/review force"), intakeLog),
    );

    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, REVIEW_QUEUE]);
    const ack = sentJobs[0]?.data;
    expect(ack?.workItemId).toBe("wi-new");
    expect(ack?.progress).toBeDefined();
    expect(ack?.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running", "wi-queued"],
      attribution: { kind: "user", login: "alice" },
    });
    expect(ack?.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: "Cancelled the previous review and started a new one on the latest commit.",
    });
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_cancel_requested",
        type: "review",
        force: true,
        cancelledCount: 2,
      }),
    );
  });

  it("force with queued and running rows keeps both cancelled ids when the insert loses the race", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-queued",
                source: "auto",
                head_sha: "queued-sha",
                created_at: "2026-01-01T00:00:02Z",
              },
            ],
          };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "running-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "winner-review", created: false }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/review force"), intakeLog),
    );

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running", "wi-queued"],
      attribution: { kind: "user", login: "alice" },
    });
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: "A `/review` run is already queued or in progress for this pull request.",
    });
  });

  it("force attribution falls back to user for an empty commenter login", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return { rows: [] };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "old-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "wi-new", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    await Effect.runPromise(
      scheduler.submitSlashCommand(
        { ...makeSlashInput("/review force"), commenterLogin: "" },
        intakeLog,
      ),
    );

    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running"],
      attribution: { kind: "user", login: "user" },
    });
    const attributionPatch = JSON.stringify({
      cancelAttribution: { kind: "user", login: "user" },
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      "acme/app#7",
      "Cancelled by slash /cancel",
      attributionPatch,
    ]);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_cancel_requested",
        cancelledByLogin: "user",
      }),
    );
  });

  it("force attribution falls back to user for an invalid commenter login", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("status = 'queued'") && sql.includes("SET status = 'cancelled'")) {
          return { rows: [] };
        }
        if (sql.includes("status = 'running'") && sql.includes("SET status = 'cancelled'")) {
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "old-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "wi-new", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    await Effect.runPromise(
      scheduler.submitSlashCommand(
        { ...makeSlashInput("/review force"), commenterLogin: "@!invalid" },
        intakeLog,
      ),
    );

    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running"],
      attribution: { kind: "user", login: "user" },
    });
    const attributionPatch = JSON.stringify({
      cancelAttribution: { kind: "user", login: "user" },
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      "acme/app#7",
      "Cancelled by slash /cancel",
      attributionPatch,
    ]);
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_cancel_requested",
        cancelledByLogin: "user",
      }),
    );
  });

  it("scopes force cancellation to the PR resource key", async () => {
    const sentJobs: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sentJobs.push({ queue, data });
        return "job-1";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("FROM pr_review_lifecycle"))
          return { rows: [] };
        if (sql.includes("INSERT INTO webhook_event_replays")) {
          return { rows: [{ body_sha256: "hash" }] };
        }
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("SET status = 'cancelled'")) {
          expect(params?.[0]).toBe("acme/app#7");
          if (sql.includes("status = 'queued'")) return { rows: [] };
          return {
            rows: [
              {
                id: "wi-running",
                source: "slash",
                head_sha: "old-sha",
                created_at: "2026-01-01T00:00:01Z",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO agent_work_items")) {
          return { rows: [{ id: "wi-new", created: true }] };
        }
        if (sql.includes("INSERT INTO publish_records")) return { rows: [] };
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({ method: "POST", path: "/webhooks" });
    await Effect.runPromise(
      scheduler.submitSlashCommand(makeSlashInput("/review force"), intakeLog),
    );

    expect(sentJobs[0]?.data.cancelProgress).toEqual({
      workItemId: "wi-running",
      cancelledWorkItemIds: ["wi-running"],
      attribution: { kind: "user", login: "alice" },
    });
  });

  it("enqueues a verification work item and pg-boss job when /verify is run", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (sql.includes("INSERT INTO agent_work_items")) {
          workItemInserts.push(params ?? []);
          return { rows: [{ id: "work-verify", created: true }] };
        }
        if (
          sql.includes("type = 'verification'") &&
          sql.includes("status IN ('queued', 'running')")
        ) {
          return { rows: [] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/verify"), intakeLog));

    expect(workItemInserts).toHaveLength(1);
    expect(workItemInserts[0]).toContain("verification");
    expect(workItemInserts[0]).toContain("slash");
    expect(sentJobs.map((j) => j.queue)).toEqual([ACK_QUEUE, VERIFICATION_QUEUE]);
    expect(sentJobs[0]?.data.workItemId).toBeDefined();
    expect(intakeLog.getContext().events).toContainEqual(
      expect.objectContaining({
        event: "agent_work_enqueued",
        type: "verification",
        source: "slash",
      }),
    );
  });

  it("replies with an in-progress notice when active verification already exists", async () => {
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
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: "event-1" }] };
        if (
          sql.includes("type = 'verification'") &&
          sql.includes("status IN ('queued', 'running')")
        ) {
          return { rows: [{ id: "active-verify" }] };
        }
        if (sql.includes("pr_actor_leases")) return { rows: [] };
        throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;
    vi.spyOn(postgres, "inTransaction").mockImplementation(async (_pool, fn) => fn(client));

    const scheduler = makeAgentWorkScheduler({} as Pool, boss, intakeCfg);
    const intakeLog = createOperationLogger({
      method: "POST",
      path: "/webhooks",
    });

    await Effect.runPromise(scheduler.submitSlashCommand(makeSlashInput("/verify"), intakeLog));

    expect(sentJobs).toHaveLength(1);
    expect(sentJobs[0]?.queue).toBe(ACK_QUEUE);
    expect(sentJobs[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: "A `/verify` run is already queued or in progress for this pull request.",
    });
    expect(sentJobs.map((j) => j.queue)).not.toContain(VERIFICATION_QUEUE);
    expect(intakeLog.getContext().events ?? []).not.toContainEqual(
      expect.objectContaining({ event: "agent_work_enqueued" }),
    );
  });
});
