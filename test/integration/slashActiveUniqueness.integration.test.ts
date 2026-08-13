import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { applySlashCommandIntake } from "../../src/agentWork/intake/slashIntake.js";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import { enqueueReviewReschedule } from "../../src/agentWork/reviewReschedule.js";
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
import { hasDatabase, integrationPool } from "./db.js";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  parseJsonText,
  type JsonObject,
} from "../../src/util/jsonValue.js";

const testFeatures = makeTestConfig().features;

const OWNER = "slash-uniq-it";
const EVENT = "slash-uniq-it";
const DATABASE_URL = process.env.DATABASE_URL!;

function parseQueuedJobData(raw: string): JsonObject {
  const parsed = parseJsonText(raw);
  if (!isJsonObject(parsed)) {
    throw new Error("expected pg-boss job data object");
  }
  return parsed;
}

function jobWorkItemId(raw: string): string | undefined {
  const data = parseQueuedJobData(raw);
  return isJsonString(data.workItemId) ? data.workItemId : undefined;
}

function jobMatchesAckResource(
  raw: string,
  owner: string,
  repo: string,
  prNumber: number,
): boolean {
  const data = parseQueuedJobData(raw);
  return (
    data.owner === owner &&
    data.repo === repo &&
    isJsonNumber(data.prNumber) &&
    data.prNumber === prNumber
  );
}

function jobReplyBody(raw: string): string | undefined {
  const data = parseQueuedJobData(raw);
  if (!isJsonObject(data.reply)) return undefined;
  return isJsonString(data.reply.body) ? data.reply.body : undefined;
}
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
      (job) => jobWorkItemId(JSON.stringify(job.data)) === workItems.rows[0]?.id,
    );
    expect(matching).toHaveLength(1);

    const ackJobs = await boss.findJobs(ACK_QUEUE, {});
    const ackForResource = ackJobs.filter((job) =>
      jobMatchesAckResource(JSON.stringify(job.data), OWNER, repo, 77),
    );
    expect(ackForResource.length).toBeGreaterThanOrEqual(1);
    const winnerAcks = ackForResource.filter(
      (job) => jobWorkItemId(JSON.stringify(job.data)) === workItems.rows[0]?.id,
    );
    const loserAcks = ackForResource.filter((job) => {
      const raw = JSON.stringify(job.data);
      return jobWorkItemId(raw) == null && jobReplyBody(raw)?.includes("already") === true;
    });
    expect(winnerAcks).toHaveLength(1);
    expect(loserAcks.length).toBe(ackForResource.length - 1);
  });

  it("slash /review deletes a failed review singleton blocker and enqueues a live job", async () => {
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 55);
    const singletonKey = `${resourceKey}:review`;
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
      { singletonKey },
    );
    expect(failedJobId).toBeTruthy();
    await pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      failedJobId,
    ]);
    await expect(boss.getBlockedKeys(REVIEW_QUEUE)).resolves.toContain(singletonKey);

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

    expect(await boss.getJobById(REVIEW_QUEUE, failedJobId!)).toBeNull();
    const reviewJobs = await boss.findJobs(REVIEW_QUEUE, { key: singletonKey });
    const live = reviewJobs.filter((job) => job.state === "created");
    expect(live).toHaveLength(1);
    expect(jobWorkItemId(JSON.stringify(live[0]?.data ?? {}))).not.toBe(failedWorkItemId);
    await expect(boss.getBlockedKeys(REVIEW_QUEUE)).resolves.not.toContain(singletonKey);
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
                rawBody: Buffer.from("{}"),
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
      payload: { staleHeadReplacementWorkItemId: replacementId },
    });

    await enqueueReviewReschedule(pool, boss, parent, replacementId, "sha-new");
    await boss.complete(REVIEW_QUEUE, replacementId, null, { includeQueued: true });
    await enqueueReviewReschedule(pool, boss, parent, replacementId, "sha-new");

    const reviewJobs = await boss.findJobs(REVIEW_QUEUE, { id: replacementId });
    expect(reviewJobs).toHaveLength(1);
    expect(reviewJobs[0]?.state).toBe("completed");
    await expect(boss.findJobs(ACK_QUEUE, { id: replacementId })).resolves.toHaveLength(1);
    const { rows } = await pool.query<{ enqueued: boolean }>(
      `SELECT (payload->>'staleHeadReplacementEnqueued')::boolean AS enqueued
         FROM agent_work_items
        WHERE id = $1`,
      [parentId],
    );
    expect(rows).toEqual([{ enqueued: true }]);
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
