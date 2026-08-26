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
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  STALE_QUEUED_WORK_GRACE_SECONDS,
} from "../../src/settings/index.js";
import type { QueueConfig } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool, requireDatabaseUrl } from "./db.js";

const OWNER = "stale-queue-it";
const DATABASE_URL = requireDatabaseUrl();

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

  async function insertAgedQueuedWork(options?: {
    readonly type?: "review" | "description";
    readonly ageSeconds?: number;
    readonly now?: Date;
  }): Promise<{
    readonly id: string;
    readonly resourceKey: string;
  }> {
    const id = randomUUID();
    const type = options?.type ?? "review";
    const ageSeconds = options?.ageSeconds ?? STALE_QUEUED_WORK_GRACE_SECONDS + 60;
    const now = options?.now ?? new Date();
    const resourceKey = `${OWNER}/r#${id.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload, created_at, updated_at
       )
       VALUES (
         $1, $2, 'auto', 'queued', $3, 'r', 1, 1, 'h', 'review', $4, '{}'::jsonb,
         $5::timestamptz - ($6 * interval '1 second'),
         $5::timestamptz - ($6 * interval '1 second')
       )`,
      [id, type, OWNER, resourceKey, now.toISOString(), ageSeconds],
    );
    return { id, resourceKey };
  }

  async function insertJobMatchingWorkItemId(options: {
    readonly workItemId: string;
    readonly queue: string;
    readonly state: "active" | "completed";
  }): Promise<void> {
    await pool.query(
      `INSERT INTO pgboss.job (id, name, state, data)
       VALUES ($1::uuid, $2, $3, $4::jsonb)`,
      [
        options.workItemId,
        options.queue,
        options.state,
        JSON.stringify({ owner: OWNER, workItemId: options.workItemId }),
      ],
    );
  }

  async function staleIds(now = new Date()): Promise<readonly string[]> {
    const report = await collectQueueDiagnostics({
      boss,
      pool,
      now,
      diagnosticQueues: [REVIEW_QUEUE, DESCRIPTION_QUEUE],
      dlqQueues: [],
    });
    return report.staleQueuedWorkItems.map((row) => row.workItemId);
  }

  it("flags a queued review with no live lease and no pg-boss job", async () => {
    const { id } = await insertAgedQueuedWork();
    expect(await staleIds()).toContain(id);
  });

  it("does not flag a queued review that still has an intake job waiting", async () => {
    const { id } = await insertAgedQueuedWork();
    const jobId = await boss.send(
      REVIEW_QUEUE,
      { kind: "review", workItemId: id, owner: OWNER },
      { group: { id: "1" } },
    );
    expect(jobId).not.toBeNull();
    expect(await staleIds()).not.toContain(id);
  });

  it("does not flag a queued review that still has a deferred watchdog hop", async () => {
    const { id } = await insertAgedQueuedWork();
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

  it("does not flag a queued review whose job id matches the work item while active", async () => {
    const { id } = await insertAgedQueuedWork();
    await insertJobMatchingWorkItemId({
      workItemId: id,
      queue: REVIEW_QUEUE,
      state: "active",
    });
    expect(await staleIds()).not.toContain(id);
    await pool.query(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [id]);
    expect(await staleIds()).toContain(id);
  });

  it("does not flag a queued description whose job id matches the work item while active", async () => {
    const { id } = await insertAgedQueuedWork({ type: "description" });
    await insertJobMatchingWorkItemId({
      workItemId: id,
      queue: DESCRIPTION_QUEUE,
      state: "active",
    });
    expect(await staleIds()).not.toContain(id);
    await pool.query(`UPDATE pgboss.job SET state = 'completed' WHERE id = $1`, [id]);
    expect(await staleIds()).toContain(id);
  });

  it("does not flag a queued review at the grace boundary", async () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const { id } = await insertAgedQueuedWork({
      ageSeconds: STALE_QUEUED_WORK_GRACE_SECONDS,
      now,
    });
    expect(await staleIds(now)).not.toContain(id);
  });

  it("flags a queued review sixty seconds past the grace boundary", async () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const { id } = await insertAgedQueuedWork({
      ageSeconds: STALE_QUEUED_WORK_GRACE_SECONDS + 60,
      now,
    });
    expect(await staleIds(now)).toContain(id);
  });
});
