import { describe, expect, it, vi } from "vitest";
import {
  promoteAskFromWebhookEvent,
  type AskIntakeInput,
} from "../src/agentWork/intake/askIntake.js";
import type { BossJobData } from "../src/agentWork/intake/queueing.js";
import { ACK_QUEUE, ASK_QUEUE, ASK_USAGE_HINT } from "../src/settings/index.js";
import { ASK_QUESTION_TOO_LONG_HINT } from "../src/commands/parseAskQuestion.js";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/ask/askSafety.js";
import {
  createJobQueue,
  createRecordingBoss,
  type RecordedBossJob,
} from "./helpers/recordingBoss.js";
import { createQueryClient } from "./helpers/fakePool.js";
import type { JsonValue } from "../src/util/jsonValue.js";

function baseInput(overrides: Partial<AskIntakeInput> = {}): AskIntakeInput {
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
    ...overrides,
  };
}

describe("promoteAskFromWebhookEvent", () => {
  it("acks usage hint without creating work", async () => {
    const sent: RecordedBossJob[] = [];
    const boss = createRecordingBoss(sent);
    const client = createQueryClient(vi.fn());

    const outcome = await promoteAskFromWebhookEvent(
      boss,
      client,
      baseInput({ body: "/ask" }),
      "skip",
    );

    expect(outcome).toEqual({ kind: "hint_acked", reason: "usage" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe(ACK_QUEUE);
    expect(sent[0]?.data).toMatchObject({
      reply: {
        target: { kind: "prConversation", prNumber: 7 },
        body: ASK_USAGE_HINT,
      },
    });
    expect(sent[0]?.options).toEqual(expect.objectContaining({ id: "event-1", priority: 100 }));
    expect(client.query).not.toHaveBeenCalled();
  });

  it("acks too-long hint for @mention inline-thread body", async () => {
    const sent: RecordedBossJob[] = [];
    const boss = createRecordingBoss(sent);
    const client = createQueryClient(vi.fn());
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
    expect(sent[0]?.data).toMatchObject({
      reply: {
        target: {
          kind: "inlineReviewThread",
          prNumber: 7,
          inReplyToCommentId: 100,
        },
        body: ASK_QUESTION_TOO_LONG_HINT,
      },
    });
  });

  it("skips enqueue when existing ask work item and policy is skip", async () => {
    const send = vi.fn(async () => "jid");
    const boss = createJobQueue({ send });
    const client = createQueryClient(
      vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [] };
        if (sql.includes("SELECT id")) return { rows: [{ id: "ask-existing" }] };
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    );

    const outcome = await promoteAskFromWebhookEvent(boss, client, baseInput(), "skip");

    expect(outcome).toEqual({ kind: "already_exists_skipped", workItemId: "ask-existing" });
    expect(send).not.toHaveBeenCalled();
  });

  it("recover-enqueues idempotently when existing ask work item", async () => {
    const sent: RecordedBossJob[] = [];
    const send = vi.fn(
      async (queue: string, data: BossJobData, options?: RecordedBossJob["options"]) => {
        sent.push({ queue, data, options });
        return null;
      },
    );
    const boss = createJobQueue({ send }, sent);
    const client = createQueryClient(
      vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [] };
        if (sql.includes("SELECT id")) return { rows: [{ id: "ask-existing" }] };
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    );

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
    const sent: { queue: string; options?: RecordedBossJob["options"] }[] = [];
    const send = vi.fn(
      async (queue: string, _data: BossJobData, options?: RecordedBossJob["options"]) => {
        sent.push({ queue, options });
        return "jid";
      },
    );
    const boss = createJobQueue({ send });
    const client = createQueryClient(
      vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO agent_work_items")) return { rows: [{ id: "ask-new" }] };
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    );

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
    const boss = createRecordingBoss([]);
    const client = createQueryClient(
      vi.fn(async (sql: string, values?: JsonValue[]) => {
        if (sql.includes("INSERT INTO agent_work_items")) {
          payloadJson = String(values?.[12] ?? "");
          return { rows: [{ id: "ask-redacted" }] };
        }
        throw new Error(`unexpected: ${sql.slice(0, 80)}`);
      }),
    );

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
