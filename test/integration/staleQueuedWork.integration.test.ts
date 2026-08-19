import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import { PR_ACTOR_LEASE_DEFER_SECONDS } from "../../src/agentWork/prActorLease.js";
import { collectQueueDiagnostics } from "../../src/agentWork/workerHealth.js";
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
  STALE_QUEUED_WORK_GRACE_SECONDS,
} from "../../src/settings/index.js";
import type { QueueConfig } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "stale-queue-it";
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

describe.skipIf(!hasDatabase)("stale queued work diagnostic (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    boss = await createStartedBoss({ databaseUrl: DATABASE_URL, role: "web" });
    await ensureAgentQueues(boss, queueConfig);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM pgboss.job WHERE data->>'owner' = $1`, [OWNER]);
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
  });

  async function insertAgedQueuedReview(): Promise<{
    readonly id: string;
    readonly resourceKey: string;
  }> {
    const id = randomUUID();
    const resourceKey = `${OWNER}/r#${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload, created_at, updated_at
       )
       VALUES (
         $1, 'review', 'auto', 'queued', $2, 'r', 1, 1, 'h', 'review', $3, '{}'::jsonb,
         now() - (($4 + 60) * interval '1 second'),
         now() - (($4 + 60) * interval '1 second')
       )`,
      [id, OWNER, resourceKey, STALE_QUEUED_WORK_GRACE_SECONDS],
    );
    return { id, resourceKey };
  }

  async function staleIds(): Promise<readonly string[]> {
    const report = await collectQueueDiagnostics({
      boss,
      pool,
      now: new Date(),
      diagnosticQueues: [REVIEW_QUEUE],
      dlqQueues: [],
    });
    return report.staleQueuedWorkItems.map((row) => row.workItemId);
  }

  it("flags a queued review with no live lease and no pg-boss job", async () => {
    const { id } = await insertAgedQueuedReview();
    expect(await staleIds()).toContain(id);
  });

  it("does not flag a queued review that still has an intake job waiting", async () => {
    const { id } = await insertAgedQueuedReview();
    const jobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: id, owner: OWNER },
      { group: { id: "1" } },
    );
    expect(jobId).not.toBeNull();
    expect(await staleIds()).not.toContain(id);
  });

  it("does not flag a queued review that still has a deferred watchdog hop", async () => {
    const { id } = await insertAgedQueuedReview();
    const jobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: id, owner: OWNER },
      {
        singletonKey: id,
        singletonSeconds: PR_ACTOR_LEASE_DEFER_SECONDS,
        singletonNextSlot: true,
        startAfter: PR_ACTOR_LEASE_DEFER_SECONDS,
        group: { id: "1" },
      },
    );
    expect(jobId).not.toBeNull();
    expect(await staleIds()).not.toContain(id);
  });
});
