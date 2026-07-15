import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import { applyThreadReplyClassifyIntake } from "../../src/agentWork/intake/threadReplyClassifyIntake.js";
import { createAskWorkItem } from "../../src/agentWork/intake/workItemRepository.js";
import { inTransaction } from "../../src/db/postgres.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createOperationLogger } from "../../src/evlog.js";
import {
  DEFERRED_HEAD_SHA,
  THREAD_REPLY_CLASSIFICATION_QUEUED,
  THREAD_REPLY_CLASSIFY_QUEUE,
} from "../../src/settings/index.js";
import { makeTestConfig } from "../helpers/config.js";
import { hasDatabase, integrationPool } from "./db.js";

const EVENT = "integration.thread_reply_classify";

describe.skipIf(!hasDatabase)("thread reply classify intake (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;
  const queueConfig = makeTestConfig({
    databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/pr_agent",
    role: "worker",
  });

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    boss = await createStartedBoss(queueConfig);
    await ensureAgentQueues(boss, queueConfig);
  });

  afterAll(async () => {
    await stopBoss(boss, 1000);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1 AND repo = $2", [
      "acme-tr",
      "app-tr",
    ]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
  });

  it("enqueues classify job transactionally with queued decision", async () => {
    const delivery = `tr-classify-${Date.now()}`;
    await inTransaction(pool, async (client) => {
      await applyThreadReplyClassifyIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery,
            rawBody: Buffer.from(JSON.stringify({ delivery })),
          },
          installationId: 1,
          owner: "acme-tr",
          repo: "app-tr",
          prNumber: 42,
          commentId: 101,
          commenterId: 7,
          authorAssociation: "MEMBER",
          body: "why is this P1?",
          replyTarget: {
            kind: "inlineReviewThread",
            prNumber: 42,
            inReplyToCommentId: 100,
          },
          inReplyToCommentId: 100,
          pullRequestReviewId: 55,
          storedReviewMatchHint: true,
        },
        createOperationLogger({ method: "POST", path: "/webhooks" }),
      );
    });

    const { rows: events } = await pool.query<{ processing_decision: string }>(
      "SELECT processing_decision FROM webhook_events WHERE delivery_id = $1",
      [delivery],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.processing_decision).toBe(THREAD_REPLY_CLASSIFICATION_QUEUED);

    const [stats] = await boss.getQueueStats(THREAD_REPLY_CLASSIFY_QUEUE);
    expect((stats?.queuedCount ?? 0) + (stats?.totalCount ?? 0)).toBeGreaterThan(0);
  });

  it("enforces one ask per webhook_event_id under concurrent inserts", async () => {
    const eventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, `tr-ask-${eventId}`, EVENT, "abc", THREAD_REPLY_CLASSIFICATION_QUEUED],
    );

    const ref = {
      owner: "acme-tr",
      repo: "app-tr",
      prNumber: 42,
      installationId: 1,
      headSha: DEFERRED_HEAD_SHA,
    };
    const replyTarget = {
      kind: "inlineReviewThread" as const,
      prNumber: 42,
      inReplyToCommentId: 100,
    };

    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        inTransaction(pool, (client) =>
          createAskWorkItem(client, {
            webhookEventId: eventId,
            ref,
            question: `q${n}`,
            replyTarget,
            commentId: 100 + n,
            commenterId: 7,
          }),
        ),
      ),
    );

    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items WHERE webhook_event_id = $1 AND type = 'ask'`,
      [eventId],
    );
    expect(rows).toHaveLength(1);
  });
});
