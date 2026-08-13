import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import { reapReviewQueueOrphans } from "../../src/agentWork/reviewQueueSlot.js";
import type { QueueConfig } from "../../src/agentWork/types.js";
import { prResourceKey, reviewSingletonKey } from "../../src/agentWork/types.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
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
  REVIEW_QUEUE,
} from "../../src/settings/index.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "orphan-reaper-it";
const EVENT = "orphan-reaper-it";
const DATABASE_URL = process.env.DATABASE_URL!;

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

async function deleteReviewJobs(boss: PgBoss): Promise<void> {
  const jobs = await boss.findJobs(REVIEW_QUEUE, {});
  if (jobs.length > 0) {
    await boss.deleteJob(
      REVIEW_QUEUE,
      jobs.map((job) => job.id),
    );
  }
}

describe.skipIf(!hasDatabase)("review queue orphan reaper (integration)", () => {
  let pool: Pool | undefined;
  let boss: PgBoss | undefined;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
    await deleteReviewJobs(boss);
  });

  afterAll(async () => {
    if (boss) await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool?.end();
  });

  afterEach(async () => {
    if (!pool || !boss) return;
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
    await deleteReviewJobs(boss);
  });

  async function insertReviewWorkItem(
    repo: string,
    resourceKey: string,
    status: "failed" | "completed",
  ): Promise<string> {
    if (!pool) throw new Error("pool is required");
    const webhookEventId = randomUUID();
    const workItemId = randomUUID();
    await pool.query(
      `INSERT INTO webhook_events (id, dedupe_key, event_name, body_sha256, processing_decision)
       VALUES ($1, $2, $3, 'sha', 'accepted')`,
      [webhookEventId, `${status}-${webhookEventId}`, EVENT],
    );
    await pool.query(
      `INSERT INTO agent_work_items (
         id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, priority, payload, completed_at
       ) VALUES (
         $1, $2, 'review', 'auto', $3, $4, $5, 9, 4242, 'sha-old', 'review', $6, 0,
         '{}'::jsonb, now()
       )`,
      [workItemId, webhookEventId, status, OWNER, repo, resourceKey],
    );
    return workItemId;
  }

  it("deletes a failed review holder whose work item is not active", async () => {
    if (!pool || !boss) throw new Error("setup required");
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 9);
    const singletonKey = reviewSingletonKey(resourceKey);
    const failedWorkItemId = await insertReviewWorkItem(repo, resourceKey, "failed");

    const failedJobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: failedWorkItemId },
      { singletonKey },
    );
    expect(failedJobId).toBeTruthy();
    await pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = now() WHERE id = $1`, [
      failedJobId,
    ]);

    await expect(reapReviewQueueOrphans(boss, pool)).resolves.toEqual({
      released: 1,
      staleQueuedLogged: 0,
    });
    await expect(boss.findJobs(REVIEW_QUEUE, { key: singletonKey })).resolves.toEqual([]);
  });

  it("cancels an active holder whose work item is completed", async () => {
    if (!pool || !boss) throw new Error("setup required");
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 9);
    const singletonKey = reviewSingletonKey(resourceKey);
    const workItemId = await insertReviewWorkItem(repo, resourceKey, "completed");

    const jobId = await boss.send(REVIEW_QUEUE, { kind: "review", workItemId }, { singletonKey });
    expect(jobId).toBeTruthy();
    await pool.query(`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = $1`, [
      jobId,
    ]);

    await expect(reapReviewQueueOrphans(boss, pool)).resolves.toEqual({
      released: 1,
      staleQueuedLogged: 0,
    });
    await expect(boss.getBlockedKeys(REVIEW_QUEUE)).resolves.not.toContain(singletonKey);
  });

  it("cancels a created holder with no workItemId", async () => {
    if (!pool || !boss) throw new Error("setup required");
    const repo = `repo-${randomUUID().slice(0, 8)}`;
    const resourceKey = prResourceKey(OWNER, repo, 9);
    const singletonKey = reviewSingletonKey(resourceKey);

    const jobId = await boss.send(REVIEW_QUEUE, { kind: "review" }, { singletonKey });
    expect(jobId).toBeTruthy();

    await expect(reapReviewQueueOrphans(boss, pool)).resolves.toEqual({
      released: 1,
      staleQueuedLogged: 0,
    });
    await expect(boss.getBlockedKeys(REVIEW_QUEUE)).resolves.not.toContain(singletonKey);
  });
});
