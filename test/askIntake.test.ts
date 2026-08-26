import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { promoteAskFromWebhookEvent } from "../src/agentWork/intake/askIntake.js";
import { ACK_QUEUE, ASK_QUEUE, ASK_THROTTLED_BODY, ASK_USAGE_HINT } from "../src/settings/index.js";
import { ASK_QUESTION_TOO_LONG_HINT } from "../src/commands/parseAskQuestion.js";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/ask/askSafety.js";
import { defaultAskQuotaConfig } from "../src/agentWork/askQuota.js";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    webhookEventId: "event-1",
    correlation: { webhookEventId: "event-1", delivery: "d1" },
    installationId: 9,
    owner: "acme",
    repo: "app",
    prNumber: 7,
    body: "/ask why?",
    replyTarget: { kind: "prConversation" as const, prNumber: 7 },
    commentId: 101,
    commenterId: 7,
    ackTargets: [
      { kind: "pr" as const, prNumber: 7 },
      { kind: "issueComment" as const, commentId: 101 },
    ],
    askQuota: defaultAskQuotaConfig(),
    ...overrides,
  };
}

function askQuotaQuery(
  sql: string,
  params?: unknown[],
  overrides: { readonly outstandingCount?: number } = {},
) {
  if (sql.includes("INSERT INTO ask_quota_buckets")) return { rows: [] };
  if (sql.includes("FROM ask_quota_buckets") && sql.includes("FOR UPDATE")) {
    return {
      rows: [
        {
          scope: params?.[0],
          scope_key: params?.[1],
          token_balance: 100,
          last_refill_at: new Date(),
          outstanding_count: overrides.outstandingCount ?? 0,
          provider_tokens_used: 0,
          provider_tokens_reserved: 0,
          provider_window_started_at: new Date(),
        },
      ],
    };
  }
  if (sql.includes("UPDATE ask_quota_buckets")) return { rows: [], rowCount: 1 };
  if (sql.includes("INSERT INTO ask_quota_reservations")) return { rows: [], rowCount: 1 };
  if (sql.includes("FROM ask_quota_reservations") && sql.includes("FOR UPDATE")) {
    return {
      rows: [
        {
          actor_scope_key: "actor:9:7",
          repository_scope_key: "repository:9:acme/app",
          installation_scope_key: "installation:9",
          reserved_provider_tokens: 0,
          released_at: null,
        },
      ],
    };
  }
  if (sql.includes("UPDATE ask_quota_reservations")) return { rows: [], rowCount: 1 };
  return undefined;
}

describe("promoteAskFromWebhookEvent", () => {
  it("acks usage hint without creating work", async () => {
    const sent: { queue: string; data: Record<string, unknown>; options?: unknown }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>, options?: unknown) => {
        sent.push({ queue, data, options });
        return "jid";
      }),
    } as unknown as PgBoss;
    const client = { query: vi.fn() } as unknown as PoolClient;

    const outcome = await promoteAskFromWebhookEvent(
      boss,
      client,
      baseInput({ body: "/ask" }),
      "skip",
    );

    expect(outcome).toEqual({ kind: "hint_acked", reason: "usage" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe(ACK_QUEUE);
    expect(sent[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: ASK_USAGE_HINT,
    });
    expect(sent[0]?.options).toEqual(expect.objectContaining({ id: "event-1", priority: 100 }));
    expect(client.query).not.toHaveBeenCalled();
  });

  it("acks too-long hint for @mention inline-thread body", async () => {
    const sent: { queue: string; data: Record<string, unknown> }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
        sent.push({ queue, data });
        return "jid";
      }),
    } as unknown as PgBoss;
    const client = { query: vi.fn() } as unknown as PoolClient;
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);

    const outcome = await promoteAskFromWebhookEvent(
      boss,
      client,
      baseInput({
        body: `@pr-agent[bot] ${long}`,
        botLogin: "pr-agent[bot]",
        replyTarget: {
          kind: "inlineReviewThread",
          prNumber: 7,
          inReplyToCommentId: 100,
        },
      }),
      "recover",
    );

    expect(outcome).toEqual({ kind: "hint_acked", reason: "too_long" });
    expect(sent[0]?.data.reply).toEqual({
      target: {
        kind: "inlineReviewThread",
        prNumber: 7,
        inReplyToCommentId: 100,
      },
      body: ASK_QUESTION_TOO_LONG_HINT,
    });
  });

  it("acks throttled asks without creating work or an ask job", async () => {
    const sent: { queue: string; data: Record<string, unknown>; options?: unknown }[] = [];
    const queries: string[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>, options?: unknown) => {
        sent.push({ queue, data, options });
        return "jid";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        const quotaResult = askQuotaQuery(sql, params, { outstandingCount: 2 });
        if (quotaResult) return quotaResult;
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const outcome = await promoteAskFromWebhookEvent(boss, client, baseInput(), "skip");

    expect(outcome).toEqual({ kind: "throttled", reason: "actor_outstanding" });
    expect(sent.map((item) => item.queue)).toEqual([ACK_QUEUE]);
    expect(sent[0]?.data.reply).toEqual({
      target: { kind: "prConversation", prNumber: 7 },
      body: ASK_THROTTLED_BODY,
    });
    expect(sent[0]?.options).toEqual(expect.objectContaining({ id: "event-1", priority: 100 }));
    expect(queries.some((sql) => sql.includes("INSERT INTO agent_work_items"))).toBe(false);
    expect(queries.some((sql) => sql.includes("INSERT INTO ask_quota_reservations"))).toBe(false);
  });

  it("skips enqueue when existing ask work item and policy is skip", async () => {
    const boss = {
      send: vi.fn(async () => "jid"),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const quotaResult = askQuotaQuery(sql, params);
        if (quotaResult) return quotaResult;
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [] };
        if (sql.includes("SELECT id")) return { rows: [{ id: "ask-existing" }] };
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const outcome = await promoteAskFromWebhookEvent(boss, client, baseInput(), "skip");

    expect(outcome).toEqual({ kind: "already_exists_skipped", workItemId: "ask-existing" });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("recover-enqueues idempotently when existing ask work item", async () => {
    const sent: { queue: string; data: Record<string, unknown>; options?: unknown }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, data: Record<string, unknown>, options?: unknown) => {
        sent.push({ queue, data, options });
        return null;
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const quotaResult = askQuotaQuery(sql, params);
        if (quotaResult) return quotaResult;
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [] };
        if (sql.includes("SELECT id")) return { rows: [{ id: "ask-existing" }] };
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const outcome = await promoteAskFromWebhookEvent(boss, client, baseInput(), "recover");

    expect(outcome).toEqual({
      kind: "promoted",
      workItemId: "ask-existing",
      created: false,
    });
    expect(sent.map((s) => s.queue)).toEqual([ACK_QUEUE, ASK_QUEUE]);
    expect(sent[0]?.options).toEqual(expect.objectContaining({ id: "event-1", priority: 100 }));
    expect(sent[1]?.options).toEqual(expect.objectContaining({ id: "ask-existing", priority: 50 }));
  });

  it("promotes a new ask with singleton keys", async () => {
    const sent: { queue: string; options?: unknown }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, _data: unknown, options?: unknown) => {
        sent.push({ queue, options });
        return "jid";
      }),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const quotaResult = askQuotaQuery(sql, params);
        if (quotaResult) return quotaResult;
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [{ id: "ask-new" }] };
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const outcome = await promoteAskFromWebhookEvent(
      boss,
      client,
      baseInput({
        body: "@pr-agent[bot] why is this P1?",
        botLogin: "pr-agent[bot]",
        replyTarget: {
          kind: "inlineReviewThread",
          prNumber: 7,
          inReplyToCommentId: 100,
        },
      }),
      "skip",
    );

    expect(outcome).toEqual({ kind: "promoted", workItemId: "ask-new", created: true });
    expect(sent.map((s) => s.queue)).toEqual([ACK_QUEUE, ASK_QUEUE]);
    expect(sent[0]?.options).toEqual(expect.objectContaining({ priority: 100 }));
    expect(sent[1]?.options).toEqual(expect.objectContaining({ id: "ask-new", priority: 50 }));
  });

  it("redacts secret-shaped question text before durable insert", async () => {
    let payloadJson = "";
    const boss = {
      send: vi.fn(async () => "jid"),
    } as unknown as PgBoss;
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        const quotaResult = askQuotaQuery(sql, values);
        if (quotaResult) return quotaResult;
        if (sql.includes("INSERT INTO agent_work_items")) {
          const payload = values?.[12];
          payloadJson = typeof payload === "string" ? payload : "";
          return { rows: [{ id: "ask-redacted" }] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    } as unknown as PoolClient;

    const token = "ghp_1234567890123456789012345678901234";
    const outcome = await promoteAskFromWebhookEvent(
      boss,
      client,
      baseInput({ body: `/ask why does ${token} fail?` }),
      "skip",
    );

    expect(outcome).toEqual({ kind: "promoted", workItemId: "ask-redacted", created: true });
    expect(payloadJson).toContain("[redacted]");
    expect(payloadJson).not.toContain(token);
  });
});
