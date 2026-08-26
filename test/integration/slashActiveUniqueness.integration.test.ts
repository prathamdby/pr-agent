import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { applySlashCommandIntake } from "../../src/agentWork/intake/slashIntake.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import {
  cancelOrphanedStaleHeadReplacementOnTerminalFailure,
  createReviewRescheduleWorkItem,
  enqueueReviewReschedule,
} from "../../src/agentWork/reviewReschedule.js";
import { getWorkItem } from "../../src/agentWork/repository.js";
import { inTransaction } from "../../src/db/postgres.js";
import { makeTestConfig } from "../helpers/config.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  ACK_QUEUE,
  ASK_QUEUE,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
} from "../../src/settings/index.js";
import type { QueueConfig } from "../../src/agentWork/types.js";
import { prResourceKey } from "../../src/agentWork/types.js";
import { makeReviewWorkItem } from "../helpers/agentWorkItems.js";
import { hasDatabase, integrationPool, requireDatabaseUrl } from "./db.js";

const testFeatures = makeTestConfig().features;

const OWNER = "slash-uniq-it";
const EVENT = "slash-uniq-it";
const DATABASE_URL = requireDatabaseUrl();
const CLEANUP_QUEUES = [
  ACK_QUEUE,
  REVIEW_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  ASK_QUEUE,
] as const;

const queueConfig: QueueConfig = {
  queueRetryLimit: DEFAULT_QUEUE_RETRY_LIMIT,
  queueRetryDelaySeconds: DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  queueRetryDelayMaxSeconds: DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  queueExpireInSeconds: DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  queueHeartbeatSeconds: DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  queuePollingIntervalSeconds: DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  queueRetentionSeconds: DEFAULT_QUEUE_RETENTION_SECONDS,
  queueDeleteAfterSeconds: DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  installationGroupConcurrency: DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
};

async function deleteQueueJobs(boss: PgBoss): Promise<void> {
  for (const queue of CLEANUP_QUEUES) {
    const jobs = await boss.findJobs(queue, {});
    if (jobs.length > 0) {
      await boss.deleteJob(
        queue,
        jobs.map((job) => job.id),
      );
    }
  }
}

async function reviewJobFor(boss: PgBoss, workItemId: string) {
  const jobs = await boss.findJobs(REVIEW_QUEUE, {});
  return jobs.find((job) => (job.data as { workItemId?: string }).workItemId === workItemId);
}

describe.skipIf(!hasDatabase)("slash active uniqueness (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
    await deleteQueueJobs(boss);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await deleteQueueJobs(boss);
  });

  function makeDescribeInput(repo: string, delivery: string, commentId: number) {
    return {
      headers: {
        event: EVENT,
        delivery,
        rawBody: Buffer.from(JSON.stringify({ delivery })),
      },
      installationId: 4242,
      owner: OWNER,
      repo,
      prNumber: 77,
      commentId,
      commenterId: 11,
      body: "/describe",
      command: "describe",
      replyTarget: { kind: "prConversation" as const, prNumber: 77 },
    };
  }

  it("concurrent same-scope /describe deliveries create one work item and one work job", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const deliveries = ["d-a", "d-b", "d-c"] as const;

    await Promise.all(
      deliveries.map((delivery, index) =>
        inTransaction(pool, (client) =>
          applySlashCommandIntake(
            boss,
            client,
            makeDescribeInput(repo, delivery, 1000 + index),
            testFeatures,
          ),
        ),
      ),
    );

    const resourceKey = prResourceKey(OWNER, repo, 77);
    const workItems = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'description' AND source = 'slash'`,
      [resourceKey],
    );
    expect(workItems.rows).toHaveLength(1);
    expect(workItems.rows[0]?.status).toBe("queued");

    const descriptionJobs = await boss.findJobs(DESCRIPTION_QUEUE, {});
    const matching = descriptionJobs.filter(
      (job) => (job.data as { workItemId?: string }).workItemId === workItems.rows[0]?.id,
    );
    expect(matching).toHaveLength(1);

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ackForResource = ackJobs.filter(
      (job) =>
        (job.data as { owner?: string; repo?: string; prNumber?: number }).owner === OWNER &&
        (job.data as { repo?: string }).repo === repo &&
        (job.data as { prNumber?: number }).prNumber === 77,
    );
    expect(ackForResource.length).toBeGreaterThanOrEqual(1);
    const winnerAcks = ackForResource.filter(
      (job) => (job.data as { workItemId?: string }).workItemId === workItems.rows[0]?.id,
    );
    const loserAcks = ackForResource.filter(
      (job) =>
        (job.data as { workItemId?: string }).workItemId == null &&
        (job.data as { reply?: { body?: string } }).reply?.body?.includes("already"),
    );
    expect(winnerAcks).toHaveLength(1);
    expect(loserAcks.length).toBe(ackForResource.length - 1);
  });

  it("slash /review enqueues a fresh review beside a failed prior job", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 55);
    const webhookEventId = randomUUID();
    const failedWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `failed-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload, completed_at
       ) VALUES (
         $1, $2, 'review', 'auto', 'failed', $3, $4, 55, 4242, 'sha-old', 'review', $5, 0,
         '{}'::jsonb, now()
       )`,
      [failedWorkItemId, webhookEventId, OWNER, repo, resourceKey],
    );

    const failedJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: failedWorkItemId },
      { id: failedWorkItemId },
    );
    expect(failedJobId).toBeTruthy();
    await pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      failedJobId,
    ]);

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery: `slash-clear-${randomUUID().slice(0, 8)}`,
            rawBody: Buffer.from("{}"),
          },
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 55,
          commentId: 5500,
          commenterId: 11,
          body: "/review",
          command: "review",
          replyTarget: { kind: "prConversation" as const, prNumber: 55 },
        },
        testFeatures,
      ),
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND status = 'queued'`,
      [resourceKey],
    );
    expect(rows).toHaveLength(1);
    const newWorkItemId = rows[0]?.id;
    expect(newWorkItemId).toBeTruthy();

    const replacementJob = await reviewJobFor(boss, newWorkItemId);
    expect(replacementJob?.state).toBe("created");
    if (failedJobId == null) throw new Error("expected failed job id");
    const failedJob = await boss.getJobById(REVIEW_QUEUE, failedJobId);
    expect(failedJob?.state).toBe("failed");
  });

  it("/review force cancels the active review and enqueues a replacement in one tx", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 44);
    const webhookEventId = randomUUID();
    const oldWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `force-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 44, 4242, 'sha-old', 'review', $5, 0,
         '{}'::jsonb
       )`,
      [oldWorkItemId, webhookEventId, OWNER, repo, resourceKey],
    );
    const oldJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: oldWorkItemId },
      { id: oldWorkItemId },
    );
    expect(oldJobId).toBeTruthy();

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery: `force-${randomUUID().slice(0, 8)}`,
            rawBody: Buffer.from("{}"),
          },
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 44,
          commentId: 4400,
          commenterId: 11,
          commenterLogin: "alice",
          body: "/review force",
          command: "review",
          replyTarget: { kind: "prConversation" as const, prNumber: 44 },
        },
        testFeatures,
      ),
    );

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'`,
      [resourceKey],
    );
    expect(rows).toHaveLength(2);
    const newRow = rows.find((row) => row.id !== oldWorkItemId);
    expect(rows).toEqual(expect.arrayContaining([{ id: oldWorkItemId, status: "cancelled" }]));
    expect(newRow?.status).toBe("queued");

    if (oldJobId == null) throw new Error("expected cancelled job id");
    if (newRow == null) throw new Error("expected replacement work item");
    const oldJob = await boss.getJobById(REVIEW_QUEUE, oldJobId);
    expect(oldJob?.state).toBe("created");
    const replacementJob = await reviewJobFor(boss, newRow.id);
    expect(replacementJob?.state).toBe("created");

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ack = ackJobs.find(
      (job) => (job.data as { workItemId?: string }).workItemId === newRow?.id,
    );
    const ackData = ack?.data as {
      progress?: unknown;
      cancelProgress?: { workItemId: string; cancelledWorkItemIds: readonly string[] };
      reply?: { body: string };
    };
    expect(ackData.progress).toBeTruthy();
    expect(ackData.cancelProgress?.workItemId).toBe(oldWorkItemId);
    expect(ackData.cancelProgress?.cancelledWorkItemIds).toEqual([oldWorkItemId]);
    expect(ackData.reply?.body).toContain("latest commit");
  });

  it("/review force leaves a sibling PR's active review untouched", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const key44 = prResourceKey(OWNER, repo, 44);
    const key45 = prResourceKey(OWNER, repo, 45);
    const webhookEventId = randomUUID();
    const oldWorkItemId = randomUUID();
    const siblingWorkItemId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `force-iso-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES
         ($1, $2, 'review', 'slash', 'running', $3, $4, 44, 4242, 'sha-old', 'review', $5, 0,
           '{}'::jsonb),
         ($6, $2, 'review', 'slash', 'running', $3, $4, 45, 4242, 'sha-sib', 'review', $7, 0,
           '{}'::jsonb)`,
      [oldWorkItemId, webhookEventId, OWNER, repo, key44, siblingWorkItemId, key45],
    );
    const oldJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: oldWorkItemId },
      { id: oldWorkItemId },
    );
    const siblingJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: siblingWorkItemId },
      { id: siblingWorkItemId },
    );
    expect(oldJobId).toBeTruthy();
    expect(siblingJobId).toBeTruthy();

    await inTransaction(pool, (client) =>
      applySlashCommandIntake(
        boss,
        client,
        {
          headers: {
            event: EVENT,
            delivery: `force-iso-${randomUUID().slice(0, 8)}`,
            rawBody: Buffer.from("{}"),
          },
          installationId: 4242,
          owner: OWNER,
          repo,
          prNumber: 44,
          commentId: 4401,
          commenterId: 11,
          commenterLogin: "alice",
          body: "/review force",
          command: "review",
          replyTarget: { kind: "prConversation" as const, prNumber: 44 },
        },
        testFeatures,
      ),
    );

    const { rows: rows44 } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'`,
      [key44],
    );
    expect(rows44).toHaveLength(2);
    const newRow = rows44.find((row) => row.id !== oldWorkItemId);
    expect(rows44).toEqual(expect.arrayContaining([{ id: oldWorkItemId, status: "cancelled" }]));
    expect(newRow?.status).toBe("queued");

    const { rows: rows45 } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items WHERE id = $1`,
      [siblingWorkItemId],
    );
    expect(rows45).toEqual([{ id: siblingWorkItemId, status: "running" }]);

    if (oldJobId == null) throw new Error("expected cancelled job id");
    if (siblingJobId == null) throw new Error("expected sibling job id");
    const oldJob = await boss.getJobById(REVIEW_QUEUE, oldJobId);
    expect(oldJob?.state).toBe("created");
    const siblingJob = await boss.getJobById(REVIEW_QUEUE, siblingJobId);
    expect(siblingJob?.state).toBe("created");

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ack = ackJobs.find(
      (job) => (job.data as { workItemId?: string }).workItemId === newRow?.id,
    );
    const ackData = ack?.data as {
      cancelProgress?: { workItemId: string; cancelledWorkItemIds: readonly string[] };
    };
    expect(ackData.cancelProgress?.cancelledWorkItemIds).toEqual([oldWorkItemId]);
  });

  it("keeps one review when a removed lens command arrives concurrently", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const lenses = ["review", "review-security"] as const;

    await Promise.all(
      lenses.map((lens, index) =>
        inTransaction(pool, (client) =>
          applySlashCommandIntake(
            boss,
            client,
            {
              headers: {
                event: EVENT,
                delivery: `lens-${lens}`,
                rawBody: Buffer.from(JSON.stringify({ command: lens })),
              },
              installationId: 4242,
              owner: OWNER,
              repo,
              prNumber: 88,
              commentId: 2000 + index,
              commenterId: 11,
              body: `/${lens}`,
              command: lens,
              replyTarget: { kind: "prConversation" as const, prNumber: 88 },
            },
            testFeatures,
          ),
        ),
      ),
    );

    const resourceKey = prResourceKey(OWNER, repo, 88);
    const { rows } = await pool.query<{ review_lens: string }>(
      `SELECT review_lens FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash' AND status = 'queued'
        ORDER BY review_lens`,
      [resourceKey],
    );
    expect(rows.map((r) => r.review_lens)).toEqual(["review"]);
  });

  it("does not uniqueness-block auto description inserts beside active slash work", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 99);
    const webhookEventId = randomUUID();
    const slashId = randomUUID();
    const autoId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `auto-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'description', 'slash', 'queued', $3, $4, 99, 4242, 'sha-slash', $5, 50, '{}'::jsonb
       )`,
      [slashId, webhookEventId, OWNER, repo, resourceKey],
    );

    await expect(
      pool.query(
        `INSERT INTO agent_work_items (
           id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, resource_key, priority, payload
         ) VALUES (
           $1, $2, 'description', 'auto', 'queued', $3, $4, 99, 4242, 'sha-auto', $5, 0, '{}'::jsonb
         )`,
        [autoId, webhookEventId, OWNER, repo, resourceKey],
      ),
    ).resolves.toBeTruthy();

    const { rows } = await pool.query<{ id: string; source: string }>(
      `SELECT id, source FROM agent_work_items
        WHERE resource_key = $1 AND type = 'description' AND status = 'queued'
        ORDER BY source`,
      [resourceKey],
    );
    expect(rows).toEqual([
      { id: autoId, source: "auto" },
      { id: slashId, source: "slash" },
    ]);
  });

  it("allows a staleHeadRescheduled replacement while the parent remains running", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 66);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `parent-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 66, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb
       )`,
      [
        parentId,
        webhookEventId,
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

    await expect(
      pool.query(
        `INSERT INTO agent_work_items (
           id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, review_lens, resource_key, priority, payload
         ) VALUES (
           $1, $2, 'review', 'slash', 'queued', $3, $4, 66, 4242, 'sha-new', 'review', $5, 0,
           $6::jsonb
         )`,
        [
          replacementId,
          webhookEventId,
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
      ),
    ).resolves.toBeTruthy();

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND type = 'review' AND source = 'slash'
        ORDER BY status`,
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

  it("atomically reuses stale-head review and ack jobs", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 57);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `reschedule-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES
       ($1, $2, 'review', 'slash', 'running', $3, $4, 57, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb),
       ($7, $2, 'review', 'slash', 'queued', $3, $4, 57, 4242, 'sha-new', 'review', $5, 0,
         $8::jsonb)`,
      [
        parentId,
        webhookEventId,
        OWNER,
        repo,
        resourceKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
        replacementId,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );
    const parent = makeReviewWorkItem({
      id: parentId,
      webhookEventId,
      owner: OWNER,
      repo,
      prNumber: 57,
      installationId: 4242,
      headSha: "sha-old",
      resourceKey,
      source: "slash",
      payload: {
        staleHeadReplacement: {
          replacementWorkItemId: replacementId,
          state: "pending-enqueue",
        },
      },
    });

    await enqueueReviewReschedule(pool, boss, parent, replacementId, "sha-new");
    await boss.complete(REVIEW_QUEUE, replacementId, null, { includeQueued: true });
    await enqueueReviewReschedule(pool, boss, parent, replacementId, "sha-new");

    const reviewJobs = await boss.findJobs(REVIEW_QUEUE, { id: replacementId });
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]?.state).toBe("completed");
    await expect(boss.findJobs(ACK_QUEUE, { id: replacementId })).resolves.toHaveLength(1);
    const { rows } = await pool.query<{
      state: string | null;
      replacement_id: string | null;
      legacy_enqueued: string | null;
    }>(
      `SELECT payload->'staleHeadReplacement'->>'state' AS state,
              COALESCE(
                payload->'staleHeadReplacement'->>'replacementWorkItemId',
                payload->>'staleHeadReplacementWorkItemId'
              ) AS replacement_id,
              payload->>'staleHeadReplacementEnqueued' AS legacy_enqueued
         FROM agent_work_items
        WHERE id = $1`,
      [parentId],
    );
    expect(rows).toEqual([
      { state: "enqueued", replacement_id: replacementId, legacy_enqueued: null },
    ]);
  });

  it("recovers a persisted-but-unenqueued replacement without duplicating or orphaning", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 58);
    const webhookEventId = randomUUID();
    const parentId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `crash-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES (
         $1, $2, 'review', 'slash', 'running', $3, $4, 58, 4242, 'sha-old', 'review', $5, 0,
         '{"mode":"review","source":"slash"}'::jsonb
       )`,
      [parentId, webhookEventId, OWNER, repo, resourceKey],
    );

    const parent = await getWorkItem(pool, parentId);
    expect(parent?.type).toBe("review");
    if (parent?.type !== "review") throw new Error("expected review parent");

    const first = await createReviewRescheduleWorkItem(pool, parent);
    const second = await createReviewRescheduleWorkItem(pool, {
      ...parent,
      payload: {
        ...parent.payload,
        staleHeadReplacement: {
          replacementWorkItemId: first.replacementWorkItemId,
          state: "pending-enqueue",
        },
      },
    });
    expect(second.replacementWorkItemId).toBe(first.replacementWorkItemId);

    const persisted = await getWorkItem(pool, parentId);
    expect(persisted?.type).toBe("review");
    if (persisted?.type !== "review") throw new Error("expected review parent");
    expect(persisted.payload.staleHeadReplacement).toEqual({
      replacementWorkItemId: first.replacementWorkItemId,
      state: "pending-enqueue",
    });

    const { rows: replacements } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND id <> $2`,
      [resourceKey, parentId],
    );
    expect(replacements).toEqual([{ id: first.replacementWorkItemId, status: "queued" }]);

    await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
      pool,
      boss,
      persisted,
      new Error("parent terminal before enqueue"),
    );

    const { rows: afterCancel } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items
        WHERE resource_key = $1 AND id <> $2`,
      [resourceKey, parentId],
    );
    expect(afterCancel).toEqual([{ id: first.replacementWorkItemId, status: "cancelled" }]);
    await expect(boss.findJobs(REVIEW_QUEUE, { id: first.replacementWorkItemId })).resolves.toEqual(
      [],
    );
  });

  it("migration cleanup cancels non-replacement duplicates and preserves a replacement pair", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 55);
    const webhookEventId = randomUUID();
    const keepId = randomUUID();
    const dupId = randomUUID();
    const parentId = randomUUID();
    const replacementId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `cleanup-${webhookEventId}`, EVENT],
    );

    await pool.query(`DROP INDEX IF EXISTS agent_work_items_slash_active_uniqueness_idx`);

    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, resource_key, priority, payload, created_at
       ) VALUES
       ($1, $2, 'description', 'slash', 'running', $3, $4, 55, 4242, 'sha', $5, 50, '{}'::jsonb, now() - interval '2 minutes'),
       ($6, $2, 'description', 'slash', 'queued', $3, $4, 55, 4242, 'sha', $5, 50, '{}'::jsonb, now() - interval '1 minute')`,
      [keepId, webhookEventId, OWNER, repo, resourceKey, dupId],
    );

    const reviewKey = prResourceKey(OWNER, repo, 56);
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload
       ) VALUES
       ($1, $2, 'review', 'slash', 'running', $3, $4, 56, 4242, 'sha-old', 'review', $5, 0,
         $6::jsonb),
       ($7, $2, 'review', 'slash', 'queued', $3, $4, 56, 4242, 'sha-new', 'review', $5, 0,
         $8::jsonb)`,
      [
        parentId,
        webhookEventId,
        OWNER,
        repo,
        reviewKey,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: replacementId,
        }),
        replacementId,
        JSON.stringify({
          mode: "review",
          source: "slash",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: replacementId,
        }),
      ],
    );

    const sql = await readFile(
      path.join(process.cwd(), "migrations/014_slash_active_uniqueness.sql"),
      "utf8",
    );
    await pool.query(sql);

    const descriptionRows = await pool.query<{
      id: string;
      status: string;
      last_error: string | null;
    }>(
      `SELECT id, status, last_error FROM agent_work_items WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[keepId, dupId]],
    );
    expect(descriptionRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: keepId, status: "running" }),
        expect.objectContaining({
          id: dupId,
          status: "cancelled",
          last_error: expect.stringContaining("014_slash_active_uniqueness"),
        }),
      ]),
    );

    const reviewRows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_work_items WHERE id = ANY($1::uuid[]) ORDER BY status`,
      [[parentId, replacementId]],
    );
    expect(reviewRows.rows).toEqual(
      expect.arrayContaining([
        { id: parentId, status: "running" },
        { id: replacementId, status: "queued" },
      ]),
    );
  });
});
