import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import { inTransaction, type IntakeClient } from "../../src/db/postgres.js";
import {
  createAskWorkItem,
  createDescriptionWorkItem,
  createReviewWorkItem,
  createTriageWorkItem,
  createVerificationWorkItem,
} from "../../src/agentWork/intake/workItemRepository.js";
import { createReviewRescheduleWorkItem } from "../../src/agentWork/reviewReschedule.js";
import { getReviewQueuePosition, getWorkItem } from "../../src/agentWork/repository.js";
import {
  getProgressCommentOwner,
  getProgressCommentRevision,
  recordPublishStep,
} from "../../src/agentWork/publishRecordRepository.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "work-item-repo-it";
const EVENT = "work-item-repo-it";

async function insertWebhookEvent(client: IntakeClient, id: string): Promise<void> {
  await client.query(
    `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
     VALUES ($1, $2, $3, 'sha', 'accepted')`,
    [id, `dedupe-${id}`, EVENT],
  );
}

function makeRef(repo: string, prNumber: number) {
  return {
    owner: OWNER,
    repo,
    prNumber,
    installationId: 4242,
    headSha: "sha-head",
  };
}

describe.skipIf(!hasDatabase)("work item repository inserts (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
  });

  it("returns created id for slash review and records progress_comment", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const webhookEventId = randomUUID();
    const ref = makeRef(repo, 10);
    const resourceKey = prResourceKey(OWNER, repo, 10);

    const result = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, webhookEventId);
      return createReviewWorkItem(client, {
        webhookEventId,
        source: "slash",
        ref,
      });
    });

    expect(result).toEqual({ created: true, id: expect.any(String) });
    const publish = await pool.query<{ step: string; status: string }>(
      `SELECT step, status FROM publish_records
        WHERE resource_key = $1 AND review_lens = 'review'`,
      [resourceKey],
    );
    expect(publish.rows).toEqual([{ step: "progress_comment", status: "pending" }]);
  });

  it("keeps one active slash review winner", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 11);
    const resourceKey = prResourceKey(OWNER, repo, 11);

    const firstEvent = randomUUID();
    const secondEvent = randomUUID();
    const first = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, firstEvent);
      return createReviewWorkItem(client, {
        webhookEventId: firstEvent,
        source: "slash",
        ref,
      });
    });
    const second = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, secondEvent);
      return createReviewWorkItem(client, {
        webhookEventId: secondEvent,
        source: "slash",
        ref,
      });
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, id: first.id });

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND review_lens = $2
          AND source = 'slash' AND status = 'queued'`,
      [resourceKey, "review"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
  });

  it("returns winner for description and triage without follow-up races", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 12);

    const descEvent = randomUUID();
    const descDup = randomUUID();
    const triageEvent = randomUUID();
    const triageDup = randomUUID();

    const desc = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, descEvent);
      return createDescriptionWorkItem(client, {
        webhookEventId: descEvent,
        source: "slash",
        ref,
      });
    });
    const descConflict = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, descDup);
      return createDescriptionWorkItem(client, {
        webhookEventId: descDup,
        source: "slash",
        ref,
      });
    });
    expect(desc.created).toBe(true);
    expect(descConflict).toEqual({ created: false, id: desc.id });

    const triage = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, triageEvent);
      return createTriageWorkItem(client, {
        webhookEventId: triageEvent,
        ref,
        commentId: 1,
        scope: "all",
        replyTarget: { kind: "prConversation", prNumber: 12 },
      });
    });
    const triageConflict = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, triageDup);
      return createTriageWorkItem(client, {
        webhookEventId: triageDup,
        ref,
        commentId: 2,
        scope: "thread",
        replyTarget: { kind: "inlineReviewThread", prNumber: 12, inReplyToCommentId: 2 },
      });
    });
    expect(triage.created).toBe(true);
    expect(triageConflict).toEqual({ created: false, id: triage.id });
  });

  it("preserves ask webhook idempotency via conflict-aware insert", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 13);
    const webhookEventId = randomUUID();

    const first = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, webhookEventId);
      return createAskWorkItem(client, {
        webhookEventId,
        ref,
        question: "what changed?",
        replyTarget: { kind: "prConversation", prNumber: 13 },
        commentId: 3,
        commenterId: 9,
      });
    });
    const second = await inTransaction(pool, async (client) =>
      createAskWorkItem(client, {
        webhookEventId,
        ref,
        question: "what changed again?",
        replyTarget: { kind: "prConversation", prNumber: 13 },
        commentId: 4,
        commenterId: 9,
      }),
    );

    expect(first).toEqual({ created: true, id: expect.any(String) });
    expect(second).toEqual({ created: false, id: first.id });

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items WHERE webhook_event_id = $1 AND type = 'ask'`,
      [webhookEventId],
    );
    expect(rows).toHaveLength(1);
  });

  it("allows auto verification beside slash work and returns plain ids", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 14);
    const slashEvent = randomUUID();
    const autoEvent = randomUUID();

    const slash = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, slashEvent);
      return createDescriptionWorkItem(client, {
        webhookEventId: slashEvent,
        source: "slash",
        ref,
      });
    });
    const verificationId = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, autoEvent);
      return createVerificationWorkItem(client, {
        webhookEventId: autoEvent,
        ref,
      });
    });

    expect(slash.created).toBe(true);
    expect(verificationId).toEqual(expect.any(String));
    expect(verificationId).not.toBe(slash.id);
  });

  it("allows staleHeadRescheduled replacement beside a running slash parent", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 15);
    const resourceKey = prResourceKey(OWNER, repo, 15);
    const parentEvent = randomUUID();
    const replacementEvent = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted'), ($4, $5, $3, 'sha', 'accepted')`,
      [parentEvent, `p-${parentEvent}`, EVENT, replacementEvent, `r-${replacementEvent}`],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 15, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb
       )`,
      [
        parentId,
        parentEvent,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'queued', $3, $4, 15, 4242, 'sha-new', 'review', $5, 0,
         $6::jsonb
       )`,
      [
        replacementId,
        replacementEvent,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    const thirdEvent = randomUUID();
    const conflict = await inTransaction(pool, async (client) => {
      await insertWebhookEvent(client, thirdEvent);
      return createReviewWorkItem(client, {
        webhookEventId: thirdEvent,
        source: "slash",
        ref,
      });
    });

    // Parent is still the active non-replacement slash winner.
    expect(conflict).toEqual({ created: false, id: parentId });

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'
        ORDER BY status, id`,
      [resourceKey],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: parentId, status: "running" },
        { id: replacementId, status: "queued" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("transfers progress ownership to a stale-head replacement", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 17);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `p-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 17, 4242, 'sha-old', 'review', $5, 0,
         '{"mode":"review","source":"slash"}'::jsonb
       )`,
      [parentId, webhookEventId, OWNER, repo, resourceKey],
    );
    await pool.query(
      `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, detail)
       VALUES ($1, $2, $3, 'review', 'progress_comment', 'completed',
               '{"progressGeneration":4,"progressRevision":6}'::jsonb)`,
      [randomUUID(), parentId, resourceKey],
    );

    const parent = await getWorkItem(pool, parentId);
    expect(parent?.type).toBe("review");
    if (parent?.type !== "review") throw new Error("expected review parent");

    const replacement = await createReviewRescheduleWorkItem(pool, parent);
    const owner = await getProgressCommentOwner(pool, resourceKey, "review");

    expect(owner).toEqual({ workItemId: replacement.replacementWorkItemId, generation: 5 });
    expect(await getProgressCommentRevision(pool, resourceKey, "review")).toBeNull();

    await recordPublishStep(pool, {
      workItemId: replacement.replacementWorkItemId,
      executionEpoch: 0,
      resourceKey,
      reviewLens: "review",
      step: "progress_comment",
      detail: { progressRevision: 0 },
    });
    await recordPublishStep(pool, {
      workItemId: parentId,
      executionEpoch: 0,
      resourceKey,
      reviewLens: "review",
      step: "progress_comment",
      detail: { progressRevision: 6 },
    });

    expect(await getProgressCommentRevision(pool, resourceKey, "review")).toEqual({
      workItemId: replacement.replacementWorkItemId,
      revision: 0,
    });
  });

  it("concurrent same-scope slash description inserts yield one winner id", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const ref = makeRef(repo, 16);
    const events = [randomUUID(), randomUUID(), randomUUID()];

    await Promise.all(
      events.map((webhookEventId) =>
        pool.query(
          `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
           VALUES ($1, $2, $3, 'sha', 'accepted')`,
          [webhookEventId, `c-${webhookEventId}`, EVENT],
        ),
      ),
    );

    const results = await Promise.all(
      events.map((webhookEventId) =>
        inTransaction(pool, (client) =>
          createDescriptionWorkItem(client, {
            webhookEventId,
            source: "slash",
            ref,
          }),
        ),
      ),
    );

    const created = results.filter((r) => r.created);
    const losers = results.filter((r) => !r.created);
    expect(created).toHaveLength(1);
    expect(losers).toHaveLength(2);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(losers.every((r) => r.id === created[0]?.id)).toBe(true);

    const resourceKey = prResourceKey(OWNER, repo, 16);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM agent_work_items
        WHERE resource_key = $1 AND type = 'description' AND source = 'slash'`,
      [resourceKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created[0]?.id);
  });

  it("ranks queued reviews with self-inclusive FIFO position SQL", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const events = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const id of events) {
      await pool.query(
        `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
         VALUES ($1, $2, $3, 'sha', 'accepted')`,
        [id, `dedupe-${id}`, EVENT],
      );
    }

    const firstId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[0]!,
        source: "auto",
        ref: makeRef(repo, 101),
      }),
    );
    const secondId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[1]!,
        source: "auto",
        ref: makeRef(repo, 102),
      }),
    );
    const thirdId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[2]!,
        source: "auto",
        ref: makeRef(repo, 103),
      }),
    );
    const runningId = await inTransaction(pool, (client) =>
      createReviewWorkItem(client, {
        webhookEventId: events[3]!,
        source: "auto",
        ref: makeRef(repo, 104),
      }),
    );
    const askId = await inTransaction(pool, (client) =>
      createAskWorkItem(client, {
        webhookEventId: events[4]!,
        ref: makeRef(repo, 105),
        question: "queue noise?",
        replyTarget: { kind: "prConversation", prNumber: 105 },
        commentId: 50,
        commenterId: 9,
      }),
    );

    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [
      firstId,
      "2026-01-01T00:00:01Z",
    ]);
    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [
      secondId,
      "2026-01-01T00:00:02Z",
    ]);
    await pool.query(`UPDATE agent_work_items SET created_at = $2 WHERE id = $1`, [
      thirdId,
      "2026-01-01T00:00:03Z",
    ]);
    await pool.query(
      `UPDATE agent_work_items SET status = 'running', created_at = $2 WHERE id = $1`,
      [runningId, "2026-01-01T00:00:00Z"],
    );
    expect(askId.id).toEqual(expect.any(String));

    await expect(getReviewQueuePosition(pool, firstId)).resolves.toEqual({
      position: 1,
      total: 3,
    });
    await expect(getReviewQueuePosition(pool, secondId)).resolves.toEqual({
      position: 2,
      total: 3,
    });
    await expect(getReviewQueuePosition(pool, thirdId)).resolves.toEqual({
      position: 3,
      total: 3,
    });
    await expect(getReviewQueuePosition(pool, runningId)).resolves.toBeNull();
    await expect(getReviewQueuePosition(pool, randomUUID())).resolves.toBeNull();
  });
});
