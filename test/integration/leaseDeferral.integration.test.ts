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
import { installationGroupId, type QueueConfig } from "../../src/agentWork/types.js";
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
  readonly singleton_on: Date | null;
  readonly data: { readonly workItemId: string };
  readonly output: unknown;
  readonly priority: number;
};

async function deferredRows(
  pool: Pool,
  singletonKey: string,
  queue: string = REVIEW_QUEUE,
): Promise<readonly DeferredRow[]> {
  const { rows } = await pool.query<DeferredRow>(
    `SELECT id::text AS id, state::text AS state, start_after, group_id,
            singleton_on, data, output, priority
       FROM pgboss.job
      WHERE name = $1 AND singleton_key = $2
      ORDER BY created_on, id`,
    [queue, singletonKey],
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

  it.each(
    LEASED_QUEUES.flatMap((queue) =>
      (["completed", "failed"] as const).flatMap((state) =>
        (["throw", "warn-and-proceed"] as const).map((onSendFailure) => ({
          queue,
          state,
          onSendFailure,
        })),
      ),
    ),
  )("re-arms past retained $state slots on $queue ($onSendFailure)", async (params) => {
    const workItemId = randomUUID();
    const foreignKey = randomUUID();
    const deferSeconds = 3600;
    const options = {
      singletonKey: workItemId,
      singletonSeconds: deferSeconds,
      singletonNextSlot: true,
      startAfter: deferSeconds,
      priority: 7,
      group: { id: "installation:651" },
    };
    try {
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, singleton_key, singleton_on, data, output,
                                completed_on)
         SELECT gen_random_uuid(), $1, $2::pgboss.job_state, $3,
                'epoch'::timestamp + interval '1 second'
                  * (3600 * floor(date_part('epoch', now()) / 3600) + slot_offset * 3600),
                jsonb_build_object('workItemId', $3::text), '{"retained":true}'::jsonb, now()
           FROM unnest(ARRAY[0, 1, 2, -10, 10]) AS offsets(slot_offset)`,
        [params.queue, params.state, workItemId],
      );
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, singleton_key, singleton_on, data)
         SELECT gen_random_uuid(), name, 'completed', key, 'epoch'::timestamp
                  + interval '1 second' * (3600 * floor(date_part('epoch', now()) / 3600)),
                jsonb_build_object('workItemId', key)
           FROM (VALUES ($1::text, $2::text), ('agent-work-ask', $3::text)) AS other(name, key)`,
        [params.queue, foreignKey, workItemId],
      );
      const before = await deferredRows(pool, workItemId, params.queue);
      const unrelated = await pool.query(
        `SELECT name, id, singleton_on, state, data, output FROM pgboss.job
          WHERE singleton_key = ANY($1::text[])
            AND (singleton_key = $2 OR name = 'agent-work-ask'
                 OR singleton_on < now() - interval '2 hours'
                 OR singleton_on > now() + interval '3 hours')
          ORDER BY name, id`,
        [[workItemId, foreignKey], foreignKey],
      );
      expect(await boss.send(params.queue, { workItemId }, options)).toBeNull();
      await expect(
        armLeaseWatchdogHop(boss, {
          ...params,
          data: { workItemId },
          singletonKey: workItemId,
          workItemId,
          deferSeconds,
          priority: 7,
          groupId: "installation:651",
        }),
      ).resolves.toEqual({ liveHop: true });
      const after = await deferredRows(pool, workItemId, params.queue);
      const hop = after.find((row) => row.state === "created");
      expect(hop).toMatchObject({
        data: { workItemId },
        group_id: "installation:651",
        priority: 7,
      });
      expect(hop?.start_after.getTime()).toBeGreaterThan(Date.now());
      for (const retained of before) {
        expect(after.find((row) => row.id === retained.id)).toMatchObject({
          state: retained.state,
          data: retained.data,
          output: retained.output,
        });
      }
      const preserved = await pool.query(
        `SELECT name, id, singleton_on, state, data, output FROM pgboss.job
          WHERE id = ANY($1::uuid[]) ORDER BY name, id`,
        [unrelated.rows.map((row: { id: string }) => row.id)],
      );
      expect(preserved.rows).toEqual(unrelated.rows);
    } finally {
      await pool.query(`DELETE FROM pgboss.job WHERE singleton_key = ANY($1::text[])`, [
        [workItemId, foreignKey],
      ]);
    }
  });

  it.each(["created", "active", "retry"] as const)(
    "keeps existing %s watchdogs singleton-suppressed with terminal history",
    async (state) => {
      const workItemId = randomUUID();
      try {
        await pool.query(
          `INSERT INTO pgboss.job (id, name, state, singleton_key, singleton_on, data)
           SELECT gen_random_uuid(), $1, $2::pgboss.job_state, $3,
                  'epoch'::timestamp + interval '1 second'
                    * (3600 * floor(date_part('epoch', now()) / 3600) + slot_offset * 3600),
                  jsonb_build_object('workItemId', $3::text)
             FROM unnest(ARRAY[0, 1, 2]) AS offsets(slot_offset)`,
          [REVIEW_QUEUE, state, workItemId],
        );
        await pool.query(
          `INSERT INTO pgboss.job (id, name, state, singleton_key, data)
           VALUES (gen_random_uuid(), $1, 'completed', $2,
                   jsonb_build_object('workItemId', $2::text))`,
          [REVIEW_QUEUE, workItemId],
        );
        const before = await deferredRows(pool, workItemId);
        await expect(
          armLeaseWatchdogHop(boss, {
            queue: REVIEW_QUEUE,
            data: { workItemId },
            singletonKey: workItemId,
            workItemId,
            groupId: "installation:651",
            deferSeconds: 3600,
            onSendFailure: "throw",
          }),
        ).resolves.toEqual({ liveHop: true });
        expect(await deferredRows(pool, workItemId)).toEqual(before);
      } finally {
        await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
          REVIEW_QUEUE,
          workItemId,
        ]);
      }
    },
  );

  it("retains the two-slot bound when terminal-slot recovery calls race", async () => {
    const workItemId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, singleton_key, singleton_on, data)
         SELECT gen_random_uuid(), $1, 'completed', $2,
                'epoch'::timestamp + interval '1 second'
                  * (3600 * floor(date_part('epoch', now()) / 3600) + slot_offset * 3600),
                jsonb_build_object('workItemId', $2::text)
           FROM unnest(ARRAY[0, 1, 2]) AS offsets(slot_offset)`,
        [REVIEW_QUEUE, workItemId],
      );
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          armLeaseWatchdogHop(boss, {
            queue: REVIEW_QUEUE,
            data: { workItemId },
            singletonKey: workItemId,
            workItemId,
            groupId: "installation:651",
            deferSeconds: 3600,
            onSendFailure: "throw",
          }),
        ),
      );
      expect(outcomes.every((outcome) => outcome.liveHop)).toBe(true);
      const live = (await deferredRows(pool, workItemId)).filter((row) => row.state === "created");
      expect(live.length).toBeGreaterThan(0);
      expect(live.length).toBeLessThanOrEqual(2);
      expect(live.every((row) => row.data.workItemId === workItemId)).toBe(true);
      expect(live.every((row) => row.group_id === "installation:651")).toBe(true);
    } finally {
      await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
        REVIEW_QUEUE,
        workItemId,
      ]);
    }
  });

  it.each(
    (["cleanup", "resend-null", "resend-error", "recheck"] as const).flatMap((fault) =>
      (["throw", "warn-and-proceed"] as const).map((onSendFailure) => ({ fault, onSendFailure })),
    ),
  )("recovers after a terminal-slot $fault fault ($onSendFailure)", async (params) => {
    const workItemId = randomUUID();
    const fault = new Error("watchdog recovery storage fault");
    const db = boss.getDb();
    const executeSql = db.executeSql.bind(db);
    try {
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, singleton_key, singleton_on, data, output)
         SELECT gen_random_uuid(), $1, 'completed', $2,
                'epoch'::timestamp + interval '1 second'
                  * (3600 * floor(date_part('epoch', now()) / 3600) + slot_offset * 3600),
                jsonb_build_object('workItemId', $2::text), '{"retained":true}'::jsonb
           FROM unnest(ARRAY[0, 1, 2]) AS offsets(slot_offset)`,
        [REVIEW_QUEUE, workItemId],
      );
      const before = await deferredRows(pool, workItemId);
      // Inject at the existing database boundary after the first real singleton
      // miss. All other statements, including the cleanup, use real Postgres.
      let reads = 0;
      let cleaned = false;
      vi.spyOn(db, "executeSql").mockImplementation(async (text, values) => {
        if (text.includes("SET singleton_on = NULL")) {
          if (params.fault === "cleanup") throw fault;
          const result = await executeSql(text, values);
          cleaned = true;
          return result;
        }
        if (cleaned && text.includes("INSERT INTO") && text.includes("singleton_on")) {
          if (params.fault === "resend-error") throw fault;
          return { rows: [] };
        }
        if (text.includes('singleton_on as "singletonOn"') && text.includes("SELECT")) {
          reads += 1;
          if (params.fault === "recheck" && reads === 2) throw fault;
        }
        return executeSql(text, values);
      });
      const result = armLeaseWatchdogHop(boss, {
        queue: REVIEW_QUEUE,
        data: { workItemId },
        singletonKey: workItemId,
        workItemId,
        groupId: "installation:651",
        deferSeconds: 3600,
        onSendFailure: params.onSendFailure,
      });
      if (params.fault === "resend-null") {
        if (params.onSendFailure === "throw") {
          await expect(result).rejects.toMatchObject({
            code: "agent_work.lease_watchdog_arm_failed",
          });
        } else {
          await expect(result).resolves.toEqual({ liveHop: false });
        }
      } else {
        await expect(result).rejects.toBe(fault);
      }
      vi.restoreAllMocks();
      const retained = await deferredRows(pool, workItemId);
      expect(retained.map(({ id, state, data, output }) => ({ id, state, data, output }))).toEqual(
        before.map(({ id, state, data, output }) => ({ id, state, data, output })),
      );
      await expect(
        armLeaseWatchdogHop(boss, {
          queue: REVIEW_QUEUE,
          data: { workItemId },
          singletonKey: workItemId,
          workItemId,
          groupId: "installation:651",
          deferSeconds: 3600,
          onSendFailure: "throw",
        }),
      ).resolves.toEqual({ liveHop: true });
      expect((await deferredRows(pool, workItemId)).some((row) => row.state === "created")).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
      await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
        REVIEW_QUEUE,
        workItemId,
      ]);
    }
  });

  it("keeps blocked work queued under terminal slots and claims its armed recovery delivery", async () => {
    const resourceKey = `lease-it/watchdog-${randomUUID().slice(0, 8)}#1`;
    const workItemId = randomUUID();
    const holderId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO agent_work_items (
           id, type, source, status, owner, repo, pr_number, installation_id,
           head_sha, review_lens, resource_key, payload
         ) VALUES (
           $1, 'review', 'auto', 'queued', 'lease-it', 'r', 1, 651, 'h', 'review', $2,
           '{"mode":"review","source":"auto"}'::jsonb
         )`,
        [workItemId, resourceKey],
      );
      await acquirePrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: holderId,
        holderId: "watchdog-it-dead-holder",
        ttlSeconds: 900,
      });
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, singleton_key, singleton_on, data)
         SELECT gen_random_uuid(), $1, 'completed', $2,
                'epoch'::timestamp + interval '1 second'
                  * (15 * floor(date_part('epoch', now()) / 15) + slot_offset * 15),
                jsonb_build_object('workItemId', $2::text)
           FROM generate_series(0, 6) AS offsets(slot_offset)`,
        [REVIEW_QUEUE, workItemId],
      );
      const { getWorkItemCore } = await import("../../src/agentWork/repository.js");
      const core = await getWorkItemCore(pool, workItemId);
      if (core == null || core.type !== "review") throw new Error("missing review core");
      await expect(
        acquireAndClaimWorkItem({
          pool,
          boss,
          queue: REVIEW_QUEUE,
          leaseKey: { resourceKey, workType: "review" },
          core,
          ttlSeconds: 900,
          seededLiveHop: false,
        }),
      ).resolves.toMatchObject({ acquired: false, heldByWorkItemId: holderId });
      const queued = await pool.query(`SELECT status FROM agent_work_items WHERE id = $1`, [
        workItemId,
      ]);
      expect(queued.rows[0]?.status).toBe("queued");
      const hop = (await deferredRows(pool, workItemId)).find((row) => row.state === "created");
      expect(hop?.group_id).toBe(installationGroupId(651));
      expect(hop?.data).toEqual({ workItemId });
      await pool.query(
        `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
          WHERE resource_key = $1 AND work_type = 'review'`,
        [resourceKey],
      );
      // Only this test's recovery row becomes deliverable; do not fetch another
      // test's jobs from the shared queue.
      await pool.query(
        `UPDATE pgboss.job SET state = 'active', started_on = now() WHERE name = $1 AND id = $2`,
        [REVIEW_QUEUE, hop?.id],
      );
      await expect(
        acquireAndClaimWorkItem({
          pool,
          boss,
          queue: REVIEW_QUEUE,
          leaseKey: { resourceKey, workType: "review" },
          core,
          ttlSeconds: 900,
          seededLiveHop: true,
        }),
      ).resolves.toMatchObject({ acquired: true });
      const claimed = await pool.query(`SELECT status FROM agent_work_items WHERE id = $1`, [
        workItemId,
      ]);
      expect(claimed.rows[0]?.status).toBe("running");
    } finally {
      await pool.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
        REVIEW_QUEUE,
        workItemId,
      ]);
      await pool.query(`DELETE FROM pr_actor_leases WHERE resource_key = $1`, [resourceKey]);
      await pool.query(`DELETE FROM agent_work_items WHERE id = $1`, [workItemId]);
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
