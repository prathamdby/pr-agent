import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import {
  acquirePrActorLease,
  armLeaseWatchdogHop,
  PR_ACTOR_LEASE_DEFER_SECONDS,
  releasePrActorLease,
} from "../../src/agentWork/prActorLease.js";
import { acquireAndClaimWorkItem } from "../../src/agentWork/durableJob.js";
import { claimWorkForExecution } from "../../src/agentWork/repository.js";
import { inTransaction } from "../../src/db/postgres.js";
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
  MIGRATIONS_DIR_NAME,
  REVIEW_QUEUE,
} from "../../src/settings/index.js";
import type { QueueConfig } from "../../src/agentWork/types.js";
import { hasDatabase, integrationPool } from "./db.js";

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

const LEASED_QUEUES = [
  "agent-work-review",
  "agent-work-description",
  "agent-work-triage",
  "agent-work-verification",
] as const;

type DeferredRow = {
  readonly id: string;
  readonly state: string;
  readonly start_after: Date;
  readonly group_id: string | null;
};

async function deferredRows(pool: Pool, singletonKey: string): Promise<readonly DeferredRow[]> {
  const { rows } = await pool.query<DeferredRow>(
    `SELECT id::text AS id, state::text AS state, start_after, group_id
       FROM pgboss.job
      WHERE name = $1 AND singleton_key = $2
      ORDER BY created_on`,
    [REVIEW_QUEUE, singletonKey],
  );
  return rows;
}

describe.skipIf(!hasDatabase)("lease deferral and policy cutover (integration)", () => {
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

  it("arms a future-dated throttled copy with the runner's exact send options", async () => {
    const workItemId = randomUUID();
    const before = Date.now();

    const id = await boss.send(
      REVIEW_QUEUE,
      { workItemId },
      {
        singletonKey: workItemId,
        singletonSeconds: PR_ACTOR_LEASE_DEFER_SECONDS,
        singletonNextSlot: true,
        startAfter: PR_ACTOR_LEASE_DEFER_SECONDS,
        group: { id: "installation:1" },
      },
    );

    expect(id).not.toBeNull();
    const rows = await deferredRows(pool, workItemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("created");
    expect(rows[0]?.group_id).toBe("installation:1");
    expect(rows[0]?.start_after.getTime()).toBeGreaterThan(
      before + (PR_ACTOR_LEASE_DEFER_SECONDS - 5) * 1000,
    );

    await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
      REVIEW_QUEUE,
      workItemId,
    ]);
  });

  it("bounds pending copies per item and re-arms after the firing copy completes", async () => {
    const key = randomUUID();
    const slotSeconds = 3;
    const sendCopy = () =>
      boss.send(
        REVIEW_QUEUE,
        { workItemId: key },
        {
          singletonKey: key,
          singletonSeconds: slotSeconds,
          singletonNextSlot: true,
          startAfter: slotSeconds,
        },
      );

    try {
      expect(await sendCopy()).not.toBeNull();
      await sendCopy();
      await sendCopy();
      expect((await deferredRows(pool, key)).length).toBeLessThanOrEqual(2);

      // Completed copies keep their rows for days, so the watchdog chain dies unless
      // the next hop lands in a fresh slot. Once the clock crosses a slot boundary a
      // new arm must succeed.
      await pool.query(
        `UPDATE pgboss.job SET state = 'completed', completed_on = now()
          WHERE name = $1 AND singleton_key = $2`,
        [REVIEW_QUEUE, key],
      );
      let rearmed: string | null = null;
      await vi.waitFor(
        async () => {
          rearmed = await sendCopy();
          expect(rearmed).not.toBeNull();
        },
        { timeout: 10_000, interval: 250 },
      );
      const rows = await deferredRows(pool, key);
      expect(rows.some((row) => row.id === rearmed && row.state === "created")).toBe(true);
    } finally {
      await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
        REVIEW_QUEUE,
        key,
      ]);
    }
  });

  it("seeds a watchdog hop on the success path with the same throttled options", async () => {
    const workItemId = randomUUID();
    const before = Date.now();
    try {
      const { liveHop } = await armLeaseWatchdogHop(boss, {
        queue: REVIEW_QUEUE,
        data: { workItemId },
        singletonKey: workItemId,
        groupId: "installation:1",
        workItemId,
        onSendFailure: "warn-and-proceed",
      });
      expect(liveHop).toBe(true);
      const rows = await deferredRows(pool, workItemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("created");
      expect(rows[0]?.start_after.getTime()).toBeGreaterThan(
        before + (PR_ACTOR_LEASE_DEFER_SECONDS - 5) * 1000,
      );
    } finally {
      await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
        REVIEW_QUEUE,
        workItemId,
      ]);
    }
  });

  it("rolls back a pre-commit crash to queued-with-free-lease so a successor acquires instantly", async () => {
    const resourceKey = `lease-it/deferral-${randomUUID().slice(0, 8)}#1`;
    const first = randomUUID();
    const second = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'auto', 'queued', 'lease-it', 'r', 1, 1, 'h', 'review', $2,
         '{"mode":"review","source":"auto"}'::jsonb
       )`,
      [first, resourceKey],
    );
    try {
      // Drive the production entry (real transaction, no seam) with a fault
      // injected between acquire and claim: the pair must roll back together,
      // never parking a held lease on the queued row.
      const coreRow = await pool.query(`SELECT id FROM agent_work_items WHERE id = $1`, [first]);
      expect(coreRow.rowCount).toBe(1);
      const { getWorkItemCore } = await import("../../src/agentWork/repository.js");
      const core = await getWorkItemCore(pool, first);
      if (core == null || core.type !== "review") throw new Error("missing review core");
      await expect(
        acquireAndClaimWorkItem({
          pool,
          boss,
          queue: REVIEW_QUEUE,
          leaseKey: { resourceKey, workType: "review" },
          core,
          ttlSeconds: 900,
          seededLiveHop: true,
          transact: async (fn) =>
            inTransaction(pool, async (client) => {
              await fn(client);
              throw new Error("fault between acquire and claim");
            }),
        }),
      ).rejects.toThrow("fault between acquire and claim");
      // No parked lease: the row is still queued and the lease is free, so a
      // successor acquires immediately with no TTL wait.
      const successor = await acquirePrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: second,
        holderId: "deferral-it-successor",
        ttlSeconds: 900,
      });
      expect(successor).toEqual({ acquired: true, leaseEpoch: 1 });
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM agent_work_items WHERE id = $1`,
        [first],
      );
      expect(rows[0]?.status).toBe("queued");
    } finally {
      await pool.query(`DELETE FROM agent_work_items WHERE id = $1`, [first]);
      await pool.query(`DELETE FROM pr_actor_leases WHERE resource_key = $1`, [resourceKey]);
    }
  });

  it("commits acquire-and-claim atomically and frees the epoch on release", async () => {
    const resourceKey = `lease-it/atomic-${randomUUID().slice(0, 8)}#1`;
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'auto', 'queued', 'lease-it', 'r', 1, 1, 'h', 'review', $2,
         '{"mode":"review","source":"auto"}'::jsonb
       )`,
      [id, resourceKey],
    );
    try {
      const committed = await inTransaction(pool, async (client) => {
        const acquisition = await acquirePrActorLease(client, {
          resourceKey,
          workType: "review",
          workItemId: id,
          holderId: "deferral-it-holder",
          ttlSeconds: 900,
        });
        if (!acquisition.acquired || acquisition.leaseEpoch !== 1) return null;
        const claimed = await claimWorkForExecution(client, id);
        if (!claimed) return null;
        return { acquisition, claimed };
      });
      expect(committed?.acquisition).toEqual({ acquired: true, leaseEpoch: 1 });
      expect(committed?.claimed.attemptCount).toBe(1);
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM agent_work_items WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.status).toBe("running");
      await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });
      const freed = await pool.query<{ work_item_id: string | null }>(
        `SELECT work_item_id FROM pr_actor_leases WHERE resource_key = $1 AND work_type = 'review'`,
        [resourceKey],
      );
      expect(freed.rows[0]?.work_item_id).toBeNull();
    } finally {
      await pool.query(`DELETE FROM agent_work_items WHERE id = $1`, [id]);
      await pool.query(`DELETE FROM pr_actor_leases WHERE resource_key = $1`, [resourceKey]);
    }
  });

  it("rolls back a claim throw after acquire inside a real transaction", async () => {
    const resourceKey = `lease-it/claim-throw-${randomUUID().slice(0, 8)}#1`;
    const id = randomUUID();
    const successorId = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'auto', 'queued', 'lease-it', 'r', 1, 1, 'h', 'review', $2,
         '{"mode":"review","source":"auto"}'::jsonb
       )`,
      [id, resourceKey],
    );
    try {
      // Claim throws after a good acquire inside the real transaction: the
      // pair rolls back, so no partial commit parks a held lease.
      const { getWorkItemCore } = await import("../../src/agentWork/repository.js");
      const core = await getWorkItemCore(pool, id);
      if (core == null || core.type !== "review") throw new Error("missing review core");
      await expect(
        acquireAndClaimWorkItem({
          pool,
          boss,
          queue: REVIEW_QUEUE,
          leaseKey: { resourceKey, workType: "review" },
          core,
          ttlSeconds: 900,
          seededLiveHop: true,
          transact: async (_fn) =>
            inTransaction(pool, async (client) => {
              const acquisition = await acquirePrActorLease(client, {
                resourceKey,
                workType: "review",
                workItemId: id,
                holderId: "deferral-it-holder",
                ttlSeconds: 900,
              });
              expect(acquisition.acquired).toBe(true);
              throw new Error("claim fault after acquire");
            }),
        }),
      ).rejects.toThrow("claim fault after acquire");
      const successor = await acquirePrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: successorId,
        holderId: "deferral-it-successor",
        ttlSeconds: 900,
      });
      expect(successor).toEqual({ acquired: true, leaseEpoch: 1 });
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM agent_work_items WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.status).toBe("queued");
    } finally {
      await pool.query(`DELETE FROM agent_work_items WHERE id = $1`, [id]);
      await pool.query(`DELETE FROM pr_actor_leases WHERE resource_key = $1`, [resourceKey]);
    }
  });

  it("retries once on deadlock and takes the claim-null release path", async () => {
    const resourceKey = `lease-it/deadlock-${randomUUID().slice(0, 8)}#1`;
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'auto', 'cancelled', 'lease-it', 'r', 1, 1, 'h', 'review', $2,
         '{"mode":"review","source":"auto"}'::jsonb
       )`,
      [id, resourceKey],
    );
    try {
      // Intake cancel already terminalized the row; the first attempt throws
      // 40P01, so the retry must re-read the cancelled row, claim-null, and
      // free the just-acquired epoch in-tx.
      const { getWorkItemCore: getCore } = await import("../../src/agentWork/repository.js");
      const core = await getCore(pool, id);
      if (core == null || core.type !== "review") throw new Error("missing review core");
      let attempts = 0;
      const result = await acquireAndClaimWorkItem({
        pool,
        boss,
        queue: REVIEW_QUEUE,
        leaseKey: { resourceKey, workType: "review" },
        core,
        ttlSeconds: 900,
        seededLiveHop: true,
        transact: (fn) =>
          inTransaction(pool, async (client) => {
            attempts += 1;
            if (attempts === 1) {
              await acquirePrActorLease(client, {
                resourceKey,
                workType: "review",
                workItemId: id,
                holderId: "deferral-it-holder",
                ttlSeconds: 900,
              });
              throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
            }
            return fn(client);
          }),
      });
      expect(result).toBeNull();
      expect(attempts).toBe(2);
      const freed = await pool.query<{ work_item_id: string | null }>(
        `SELECT work_item_id FROM pr_actor_leases WHERE resource_key = $1 AND work_type = 'review'`,
        [resourceKey],
      );
      expect(freed.rows[0]?.work_item_id).toBeNull();
    } finally {
      await pool.query(`DELETE FROM agent_work_items WHERE id = $1`, [id]);
      await pool.query(`DELETE FROM pr_actor_leases WHERE resource_key = $1`, [resourceKey]);
    }
  });

  it("flips pre-existing key_strict_fifo queue policies when migration 023 replays", async () => {
    const { rows: regclass } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('pgboss.queue')::text AS reg`,
    );
    const pgbossExisted = regclass[0]?.reg != null;
    if (!pgbossExisted) {
      await pool.query(`CREATE SCHEMA pgboss`);
      await pool.query(`CREATE TABLE pgboss.queue (name text PRIMARY KEY, policy text NOT NULL)`);
      for (const name of LEASED_QUEUES) {
        await pool.query(`INSERT INTO pgboss.queue (name, policy) VALUES ($1, 'key_strict_fifo')`, [
          name,
        ]);
      }
    }

    const { rows: before } = await pool.query<{ name: string; policy: string }>(
      `SELECT name, policy FROM pgboss.queue WHERE name = ANY($1)`,
      [LEASED_QUEUES],
    );
    const restore = new Map(before.map((row) => [row.name, row.policy]));

    try {
      await pool.query(`UPDATE pgboss.queue SET policy = 'key_strict_fifo' WHERE name = ANY($1)`, [
        LEASED_QUEUES,
      ]);

      const sql = await readFile(
        path.join(process.cwd(), MIGRATIONS_DIR_NAME, "023_pr_actor_leases.sql"),
        "utf8",
      );
      await pool.query(sql);

      const { rows: after } = await pool.query<{ name: string; policy: string }>(
        `SELECT name, policy FROM pgboss.queue WHERE name = ANY($1) ORDER BY name`,
        [LEASED_QUEUES],
      );
      expect(after.map((row) => row.policy)).toEqual([
        "standard",
        "standard",
        "standard",
        "standard",
      ]);
    } finally {
      if (pgbossExisted) {
        for (const [name, policy] of restore) {
          await pool.query(`UPDATE pgboss.queue SET policy = $2 WHERE name = $1`, [name, policy]);
        }
      } else {
        await pool.query(`DROP SCHEMA pgboss CASCADE`);
      }
    }
  });
});
