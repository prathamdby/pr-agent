import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import {
  acquirePrActorLease,
  PR_ACTOR_LEASE_DEFER_SECONDS,
  renewPrActorLease,
} from "../../src/agentWork/prActorLease.js";
import { reviewVerdict } from "../../src/agentWork/reviewVerdict.js";
import { withOwnVerdictClose } from "../../src/agentWork/publishRecordRepository.js";
import {
  listTerminalReviewsWithOpenOwnChecks,
  reconcileLostRunningWork,
} from "../../src/agentWork/lostRunningWork.js";
import * as workState from "../../src/agentWork/workItemStateRepository.js";
import {
  claimWorkForExecution,
  markWorkCompleted,
} from "../../src/agentWork/workItemStateRepository.js";
import { recordReviewCheckRun } from "../../src/agentWork/publishRecordRepository.js";
import { collectQueueDiagnostics } from "../../src/agentWork/workerHealth.js";
import { runMigrations } from "../../src/db/migrations.js";
import { inTransaction } from "../../src/db/postgres.js";
import * as evlog from "../../src/evlog.js";
import * as installationToken from "../../src/github/installationToken.js";
import * as prSurface from "../../src/github/prSurface.js";
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
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../../src/settings/index.js";
import type { QueueConfig } from "../../src/agentWork/types.js";
import { makeTestConfig } from "../helpers/config.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "stale-queue-it";
const DATABASE_URL = process.env.DATABASE_URL!;

const queueConfig: QueueConfig = makeTestConfig({
  queue: {
    retryLimit: DEFAULT_QUEUE_RETRY_LIMIT,
    retryDelaySeconds: DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
    retryDelayMaxSeconds: DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
    expireInSeconds: DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
    heartbeatSeconds: DEFAULT_QUEUE_HEARTBEAT_SECONDS,
    pollingIntervalSeconds: DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
    retentionSeconds: DEFAULT_QUEUE_RETENTION_SECONDS,
    deleteAfterSeconds: DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  },
  concurrency: { installationGroup: DEFAULT_INSTALLATION_GROUP_CONCURRENCY },
});

describe.skipIf(!hasDatabase)("stale queued work diagnostic (integration)", () => {
  let pool: Pool;
  let boss: PgBoss;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
    boss = await createStartedBoss(
      makeTestConfig({ runtime: { databaseUrl: DATABASE_URL, role: "web" } }),
    );
    await ensureAgentQueues(boss, queueConfig);
  });

  afterAll(async () => {
    await stopBoss(boss, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS * 1000);
    await pool.end();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  // Failure modes: stale statement snapshots, revival insert phantoms, rowless
  // lease acquisition, lock/budget cleanup, and closing checks after a no-op.
  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((workType) =>
      (["renewal", "job update", "job insert"] as const).map((revival) => ({
        workType,
        revival,
      })),
    ),
  )("preserves $workType when $revival commits during failure", async ({ workType, revival }) => {
    const cfg = makeTestConfig({
      features: { ...makeTestConfig().features, commitStatus: true },
    });
    const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
    const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
    await pool.query(
      `UPDATE agent_work_items
          SET type = $2, source = $3, status = 'running', started_at = created_at
        WHERE id = $1`,
      [id, workType, workType === "triage" ? "slash" : "auto"],
    );
    const queue = {
      review: REVIEW_QUEUE,
      description: DESCRIPTION_QUEUE,
      triage: TRIAGE_QUEUE,
      verification: VERIFICATION_QUEUE,
    }[workType];
    let epoch: number | null = null;
    if (revival === "renewal") {
      const lease = await acquirePrActorLease(pool, {
        resourceKey,
        workType,
        workItemId: id,
        holderId: OWNER,
        ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
      });
      if (!lease.acquired) throw new Error("Expected initial lease");
      epoch = lease.leaseEpoch;
      await pool.query(
        "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE work_item_id = $1",
        [id],
      );
    }
    const jobId = randomUUID();
    if (revival === "job update") {
      await pool.query(
        "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'completed', $3::jsonb)",
        [jobId, queue, JSON.stringify({ owner: OWNER, workItemId: id })],
      );
    }
    const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    const token = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
      token: "synthetic-integration-token",
      expiresAtTs: Date.now() + 60_000,
      ttlMs: 60_000,
    });
    const factory = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
    if (workType === "review") {
      const check = await fake.surface.startReviewCheck("h", id, "Running");
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        detail: { status: "in_progress" },
      });
    }
    const snapshot = await collectQueueDiagnostics({
      boss,
      pool,
      now: new Date(),
      diagnosticQueues: [],
      dlqQueues: [],
      lostRunningMinAgeSeconds: minAgeSeconds,
    });
    expect(snapshot.lostRunningWorkItems.map((item) => item.workItemId)).toContain(id);
    const before = await pool.query(
      "SELECT status, last_error, completed_at, updated_at FROM agent_work_items WHERE id = $1",
      [id],
    );
    const blocker = await pool.connect();
    const writer = await pool.connect();
    const observer = await pool.connect();
    let blockerOpen = false;
    let writerOpen = false;
    let settled = false;
    let blocked = false;
    let sweep: Promise<void> | undefined;
    try {
      const { rows } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("BEGIN");
      blockerOpen = true;
      // Lock without rewriting the item, avoiding a new tuple/EPQ confounder.
      await blocker.query("SELECT id FROM agent_work_items WHERE id = $1 FOR UPDATE", [id]);
      await writer.query("BEGIN");
      writerOpen = true;
      if (revival === "renewal") {
        if (epoch == null) throw new Error("Expected initial epoch");
        expect(
          await renewPrActorLease(writer, {
            resourceKey,
            workType,
            workItemId: id,
            leaseEpoch: epoch,
            ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
          }),
        ).toBe(true);
      } else if (revival === "job update") {
        await writer.query("UPDATE pgboss.job SET state = 'active' WHERE id = $1", [jobId]);
      } else {
        await writer.query(
          "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'active', $3::jsonb)",
          [jobId, queue, JSON.stringify({ owner: OWNER, workItemId: id })],
        );
      }
      sweep = reconcileLostRunningWork({
        cfg,
        pool,
        items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
      }).finally(() => {
        settled = true;
      });
      await expect
        .poll(async () => {
          const result = await observer.query<{ blocked: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database()
                  AND $1::int = ANY(pg_blocking_pids(pid))
                  AND query ILIKE '%UPDATE%agent_work_items%'
             ) AS blocked`,
            [rows[0]?.pid],
          );
          blocked = result.rows[0]?.blocked ?? false;
          return blocked || settled;
        })
        .toBe(true);
      await writer.query("COMMIT");
      writerOpen = false;
      const live = await observer.query<{ live: boolean }>(
        revival === "renewal"
          ? "SELECT expires_at > statement_timestamp() AS live FROM pr_actor_leases WHERE work_item_id = $1"
          : "SELECT state = 'active' AS live FROM pgboss.job WHERE id = $1",
        [revival === "renewal" ? id : jobId],
      );
      expect(live.rows[0]?.live).toBe(true);
      await blocker.query("COMMIT");
      blockerOpen = false;
      await sweep;
      console.info("lost-running race schedule", { workType, revival, blocked, settled });
      expect(
        (
          await observer.query(
            "SELECT status, last_error, completed_at, updated_at FROM agent_work_items WHERE id = $1",
            [id],
          )
        ).rows,
      ).toEqual(before.rows);
      expect(token).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(
        fake.controls.events.filter(
          (event) => event.kind === "finishReviewCheck" || event.kind === "setReviewCommitStatus",
        ),
      ).toEqual([]);
    } finally {
      if (writerOpen) await writer.query("ROLLBACK");
      if (blockerOpen) await blocker.query("ROLLBACK");
      await sweep;
      observer.release();
      writer.release();
      blocker.release();
    }
    await reconcileLostRunningWork({
      cfg,
      pool,
      items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
    });
    expect(
      (
        await pool.query(
          "SELECT status, last_error, completed_at, updated_at FROM agent_work_items WHERE id = $1",
          [id],
        )
      ).rows,
    ).toEqual(before.rows);
  });

  it.each(["lease insert", "job insert"] as const)(
    "sees a committed $revival after routing despite a repeatable-read default",
    async (revival) => {
      const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: 1800 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
      const sweeper = await pool.connect();
      const writer = await pool.connect();
      const release = sweeper.release.bind(sweeper);
      const read = sweeper.query.bind(sweeper);
      const defaults = await read(
        `SELECT current_setting('default_transaction_isolation') AS isolation,
                current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
      );
      await read("SET default_transaction_isolation = 'repeatable read'");
      vi.spyOn(sweeper, "release").mockImplementation(() => undefined);
      const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => sweeper);
      let revived = false;
      const errors: unknown[] = [];
      vi.spyOn(sweeper, "query").mockImplementation(async (text, values) => {
        try {
          const result = await read(text, values);
          if (
            !revived &&
            typeof text === "string" &&
            text.includes("SELECT resource_key, type") &&
            values?.[0] === id
          ) {
            revived = true;
            if (revival === "lease insert") {
              expect(
                await acquirePrActorLease(writer, {
                  resourceKey,
                  workType: "review",
                  workItemId: id,
                  holderId: OWNER,
                  ttlSeconds: 900,
                }),
              ).toMatchObject({ acquired: true });
            } else {
              await writer.query(
                "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'retry', $3::jsonb)",
                [randomUUID(), REVIEW_QUEUE, JSON.stringify({ owner: OWNER, workItemId: id })],
              );
            }
          }
          return result;
        } catch (error) {
          errors.push(error);
          throw error;
        }
      });
      try {
        expect(await workState.markLostRunningWorkFailed(pool, id, 1200)).toBe(false);
        expect(revived).toBe(true);
        expect(errors).toEqual([]);
        expect(
          (await writer.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
        ).toEqual(before.rows);
        const after = await read(
          `SELECT current_setting('default_transaction_isolation') AS isolation,
                  current_setting('statement_timeout') AS statement,
                  current_setting('idle_in_transaction_session_timeout') AS idle`,
        );
        expect(after.rows[0]).toEqual({
          ...defaults.rows[0],
          isolation: "repeatable read",
        });
      } finally {
        connect.mockRestore();
        vi.mocked(sweeper.query).mockRestore();
        await read("SELECT set_config('default_transaction_isolation', $1, false)", [
          defaults.rows[0].isolation,
        ]);
        vi.mocked(sweeper.release).mockRestore();
        release();
        writer.release();
      }
    },
  );

  it.each(["renewal", "job insert"] as const)(
    "serializes a later $revival behind the protected failure",
    async (revival) => {
      const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: 1800 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const lease = await acquirePrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: id,
        holderId: OWNER,
        ttlSeconds: 900,
      });
      if (!lease.acquired) throw new Error("Expected lease");
      await pool.query(
        "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE work_item_id = $1",
        [id],
      );
      const sweeper = await pool.connect();
      const writer = await pool.connect();
      const observer = await pool.connect();
      const read = sweeper.query.bind(sweeper);
      const release = sweeper.release.bind(sweeper);
      const { rows: sweepPid } = await read<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const { rows: writerPid } = await writer.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const before = await read(
        `SELECT current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
      );
      let locked: (() => void) | undefined;
      let proceed: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      vi.spyOn(sweeper, "release").mockImplementation(() => undefined);
      const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => sweeper);
      vi.spyOn(sweeper, "query").mockImplementation(async (text, values) => {
        const result = await read(text, values);
        if (text === "LOCK TABLE pgboss.job IN SHARE MODE NOWAIT") {
          locked?.();
          await barrier;
        }
        return result;
      });
      const marking = workState
        .markLostRunningWorkFailed(pool, id, 1200)
        .catch((error: unknown) => error);
      let revivalResult: Promise<unknown> | undefined;
      try {
        await Promise.race([ready, marking]);
        revivalResult = (
          revival === "renewal"
            ? renewPrActorLease(writer, {
                resourceKey,
                workType: "review",
                workItemId: id,
                leaseEpoch: lease.leaseEpoch,
                ttlSeconds: 900,
              })
            : writer.query(
                "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'created', $3::jsonb)",
                [randomUUID(), REVIEW_QUEUE, JSON.stringify({ owner: OWNER, workItemId: id })],
              )
        ).catch((error: unknown) => error);
        await expect
          .poll(async () => {
            const { rows } = await observer.query<{ blocked: boolean }>(
              "SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked",
              [sweepPid[0]?.pid, writerPid[0]?.pid],
            );
            return rows[0]?.blocked;
          })
          .toBe(true);
        proceed?.();
        expect(await marking).toBe(true);
        if (revival === "renewal") expect(await revivalResult).toBe(true);
        else expect(await revivalResult).toMatchObject({ rowCount: 1 });
        expect(
          (await observer.query("SELECT status FROM agent_work_items WHERE id = $1", [id])).rows,
        ).toEqual([{ status: "failed" }]);
        expect(await workState.claimWorkForExecution(observer, id)).toBeNull();
        const after = await read(
          `SELECT current_setting('statement_timeout') AS statement,
                  current_setting('idle_in_transaction_session_timeout') AS idle`,
        );
        expect(after.rows).toEqual(before.rows);
      } finally {
        proceed?.();
        await marking;
        await revivalResult;
        connect.mockRestore();
        vi.mocked(sweeper.query).mockRestore();
        vi.mocked(sweeper.release).mockRestore();
        release();
        writer.release();
        observer.release();
      }
    },
  );

  it.each(["uncommitted cancellation", "cancellation after routing"] as const)(
    "preserves running work during %s",
    async (cancellation) => {
      const cfg = makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: true },
      });
      const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      const token = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "synthetic-integration-token",
        expiresAtTs: Date.now() + 60_000,
        ttlMs: 60_000,
      });
      const factory = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      const check = await fake.surface.startReviewCheck("h", id, "Running");
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        detail: { status: "in_progress" },
      });
      const snapshot = await collectQueueDiagnostics({
        boss,
        pool,
        now: new Date(),
        diagnosticQueues: [],
        dlqQueues: [],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      const items = snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id);
      expect(items).toHaveLength(1);
      const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
      const writer = await pool.connect();
      const sweeper = await pool.connect();
      const read = sweeper.query.bind(sweeper);
      const release = sweeper.release.bind(sweeper);
      let writerOpen = false;
      let routed = false;
      const outcomes: boolean[] = [];
      const mark = workState.markLostRunningWorkFailed;
      vi.spyOn(workState, "markLostRunningWorkFailed").mockImplementation(async (...args) => {
        const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => sweeper);
        try {
          const result = await mark(...args);
          outcomes.push(result);
          return result;
        } finally {
          connect.mockRestore();
        }
      });
      vi.spyOn(sweeper, "release").mockImplementation(() => undefined);
      vi.spyOn(sweeper, "query").mockImplementation(async (text, values) => {
        const result = await read(text, values);
        if (
          !routed &&
          typeof text === "string" &&
          text.includes("SELECT resource_key, type") &&
          values?.[0] === id
        ) {
          routed = true;
          if (cancellation === "cancellation after routing") {
            await writer.query(
              "UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1",
              [id],
            );
            await writer.query("COMMIT");
            writerOpen = false;
          }
        }
        return result;
      });
      try {
        await writer.query("BEGIN");
        writerOpen = true;
        if (cancellation === "uncommitted cancellation") {
          await writer.query(
            "UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1",
            [id],
          );
        }
        await reconcileLostRunningWork({ cfg, pool, items });
        expect(routed).toBe(true);
        expect(outcomes).toEqual([false]);
        if (writerOpen) {
          expect(
            (await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
          ).toEqual(before.rows);
          await writer.query("COMMIT");
          writerOpen = false;
        }
        const cancelled = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
        expect(cancelled.rows).toEqual([
          { ...before.rows[0], cancel_requested_at: expect.any(Date) },
        ]);
        await reconcileLostRunningWork({ cfg, pool, items });
        expect(
          (await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
        ).toEqual(cancelled.rows);
        expect(token).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        expect(
          fake.controls.events.filter(
            (event) => event.kind === "finishReviewCheck" || event.kind === "setReviewCommitStatus",
          ),
        ).toEqual([]);
      } finally {
        if (writerOpen) await writer.query("ROLLBACK");
        vi.mocked(sweeper.query).mockRestore();
        vi.mocked(sweeper.release).mockRestore();
        release();
        writer.release();
      }
    },
  );

  it.each(["item", "lease", "missing lease", "unrelated job"] as const)(
    "defers on %s contention and recovers after it ends",
    async (block) => {
      const cfg = makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: true },
      });
      const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      const token = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "synthetic-integration-token",
        expiresAtTs: Date.now() + 60_000,
        ttlMs: 60_000,
      });
      const factory = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      const check = await fake.surface.startReviewCheck("h", id, "Running");
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        detail: { status: "in_progress" },
      });
      const finish = fake.surface.finishReviewCheck.bind(fake.surface);
      vi.spyOn(fake.surface, "finishReviewCheck").mockImplementation(async (...args) => {
        expect(
          (
            await pool.query(
              "SELECT status, last_error, completed_at FROM agent_work_items WHERE id = $1",
              [id],
            )
          ).rows,
        ).toEqual([
          { status: "failed", last_error: "worker_lost", completed_at: expect.any(Date) },
        ]);
        return finish(...args);
      });
      if (block !== "missing lease") {
        await acquirePrActorLease(pool, {
          resourceKey,
          workType: "review",
          workItemId: id,
          holderId: OWNER,
          ttlSeconds: 900,
        });
        await pool.query(
          "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE work_item_id = $1",
          [id],
        );
      }
      const snapshot = await collectQueueDiagnostics({
        boss,
        pool,
        now: new Date(),
        diagnosticQueues: [],
        dlqQueues: [],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      const items = snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id);
      expect(items).toHaveLength(1);
      const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
      const checkBefore = await pool.query(
        "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
        [id],
      );
      const outcomes: boolean[] = [];
      const mark = workState.markLostRunningWorkFailed;
      vi.spyOn(workState, "markLostRunningWorkFailed").mockImplementation(async (...args) => {
        const result = await mark(...args);
        outcomes.push(result);
        return result;
      });
      const blocker = await pool.connect();
      let open = false;
      try {
        await blocker.query("BEGIN");
        open = true;
        if (block === "item") {
          await blocker.query("SELECT id FROM agent_work_items WHERE id = $1 FOR UPDATE", [id]);
        } else if (block === "lease") {
          await blocker.query(
            "SELECT resource_key FROM pr_actor_leases WHERE work_item_id = $1 FOR UPDATE",
            [id],
          );
        } else if (block === "missing lease") {
          expect(
            await acquirePrActorLease(blocker, {
              resourceKey,
              workType: "review",
              workItemId: id,
              holderId: OWNER,
              ttlSeconds: 900,
            }),
          ).toMatchObject({ acquired: true });
          expect(
            (
              await pool.query("SELECT resource_key FROM pr_actor_leases WHERE resource_key = $1", [
                resourceKey,
              ])
            ).rows,
          ).toEqual([]);
        } else {
          await blocker.query(
            "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'created', $3::jsonb)",
            [randomUUID(), DESCRIPTION_QUEUE, JSON.stringify({ owner: OWNER })],
          );
        }
        const started = performance.now();
        await reconcileLostRunningWork({ cfg, pool, items });
        expect(outcomes).toEqual([false]);
        console.info("lost-running contention duration", {
          block,
          durationMs: performance.now() - started,
        });
        expect(
          (await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
        ).toEqual(before.rows);
        expect(
          (
            await pool.query(
              "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
              [id],
            )
          ).rows,
        ).toEqual(checkBefore.rows);
        expect(token).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
        expect(
          fake.controls.events.filter(
            (event) => event.kind === "finishReviewCheck" || event.kind === "setReviewCommitStatus",
          ),
        ).toEqual([]);
        await blocker.query("ROLLBACK");
        open = false;
        await reconcileLostRunningWork({ cfg, pool, items });
        expect(outcomes).toEqual([false, true]);
        await reconcileLostRunningWork({ cfg, pool, items });
        expect(outcomes).toEqual([false, true]);
        expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual([
          expect.objectContaining({ conclusion: "action_required" }),
        ]);
        expect(
          fake.controls.events.filter((event) => event.kind === "setReviewCommitStatus"),
        ).toEqual([
          expect.objectContaining({ status: expect.objectContaining({ state: "error" }) }),
        ]);
      } finally {
        if (open) await blocker.query("ROLLBACK");
        blocker.release();
      }
    },
  );

  it.each(["55P03", "57014"] as const)(
    "propagates an early routing error %s and warns during reconciliation",
    async (code) => {
      const cfg = makeTestConfig();
      const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      const { id } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const snapshot = await collectQueueDiagnostics({
        boss,
        pool,
        now: new Date(),
        diagnosticQueues: [],
        dlqQueues: [],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      const items = snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id);
      expect(items).toHaveLength(1);
      const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
      const blocker = await pool.connect();
      const sweeper = await pool.connect();
      const read = sweeper.query.bind(sweeper);
      const release = sweeper.release.bind(sweeper);
      const defaults = await read(
        `SELECT current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
      );
      const warn = vi.spyOn(evlog, "logWarn");
      const mark = workState.markLostRunningWorkFailed;
      vi.spyOn(workState, "markLostRunningWorkFailed").mockImplementation(async (...args) => {
        const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => sweeper);
        try {
          return await mark(...args);
        } finally {
          connect.mockRestore();
        }
      });
      vi.spyOn(sweeper, "release").mockImplementation(() => undefined);
      const query = vi.spyOn(sweeper, "query").mockImplementation(async (text, values) => {
        if (
          typeof text === "string" &&
          text.includes("SELECT resource_key, type") &&
          values?.[0] === id
        ) {
          if (code === "55P03") {
            await read("SELECT id FROM agent_work_items WHERE id = $1 FOR UPDATE NOWAIT", [id]);
          } else {
            await read("SELECT pg_sleep(5)");
          }
        }
        return read(text, values);
      });
      let open = false;
      try {
        await blocker.query("BEGIN");
        open = true;
        await blocker.query("SELECT id FROM agent_work_items WHERE id = $1 FOR UPDATE", [id]);
        await expect(
          workState.markLostRunningWorkFailed(pool, id, minAgeSeconds),
        ).rejects.toMatchObject({
          code,
        });
        await reconcileLostRunningWork({ cfg, pool, items });
        expect(warn).toHaveBeenCalledWith(
          "lost_running_work_reconcile_failed",
          expect.objectContaining({ workItemId: id, message: expect.any(String) }),
        );
        expect(
          (await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
        ).toEqual(before.rows);
        expect(
          (
            await read(
              `SELECT current_setting('statement_timeout') AS statement,
                      current_setting('idle_in_transaction_session_timeout') AS idle`,
            )
          ).rows,
        ).toEqual(defaults.rows);
        await blocker.query("ROLLBACK");
        open = false;
        query.mockRestore();
        expect(await workState.markLostRunningWorkFailed(pool, id, minAgeSeconds)).toBe(true);
      } finally {
        if (open) await blocker.query("ROLLBACK");
        query.mockRestore();
        vi.mocked(sweeper.release).mockRestore();
        release();
        blocker.release();
      }
    },
  );

  it("rolls back a timed-out protected query and frees an unrelated queue writer", async () => {
    const { id } = await insertAgedQueuedWork({ ageSeconds: 1800 });
    await pool.query(
      "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
      [id],
    );
    const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
    const sweeper = await pool.connect();
    const writer = await pool.connect();
    const observer = await pool.connect();
    const read = sweeper.query.bind(sweeper);
    const release = sweeper.release.bind(sweeper);
    const defaults = await read(
      `SELECT current_setting('statement_timeout') AS statement,
              current_setting('idle_in_transaction_session_timeout') AS idle`,
    );
    const { rows: sweepPid } = await read<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const { rows: writerPid } = await writer.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    let active: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      active = resolve;
    });
    let cancellation: unknown;
    vi.spyOn(sweeper, "release").mockImplementation(() => undefined);
    const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => sweeper);
    vi.spyOn(sweeper, "query").mockImplementation(async (text, values) => {
      if (typeof text === "string" && /UPDATE\s+agent_work_items/i.test(text)) {
        active?.();
        try {
          await read("SELECT pg_sleep(5)");
        } catch (error) {
          cancellation = error;
          throw error;
        }
      }
      return read(text, values);
    });
    const started = performance.now();
    const marking = workState
      .markLostRunningWorkFailed(pool, id, 1200)
      .catch((error: unknown) => error);
    let insert: Promise<unknown> | undefined;
    try {
      await Promise.race([ready, marking]);
      insert = writer
        .query(
          "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'created', $3::jsonb)",
          [randomUUID(), DESCRIPTION_QUEUE, JSON.stringify({ owner: OWNER })],
        )
        .catch((error: unknown) => error);
      await expect
        .poll(async () => {
          const { rows } = await observer.query<{ blocked: boolean }>(
            "SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked",
            [sweepPid[0]?.pid, writerPid[0]?.pid],
          );
          return rows[0]?.blocked;
        })
        .toBe(true);
      expect(await marking).toBe(false);
      expect(cancellation).toMatchObject({ code: "57014" });
      expect(await insert).toMatchObject({ rowCount: 1 });
      console.info("lost-running protected timeout duration", {
        durationMs: performance.now() - started,
      });
      expect(
        (await observer.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
      ).toEqual(before.rows);
      expect(
        (
          await read(
            `SELECT current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
          )
        ).rows,
      ).toEqual(defaults.rows);
    } finally {
      await marking;
      await insert;
      connect.mockRestore();
      vi.mocked(sweeper.query).mockRestore();
      vi.mocked(sweeper.release).mockRestore();
      release();
      writer.release();
      observer.release();
    }
  });

  it.each(["idle timeout", "SQL error"] as const)(
    "rejects an unexpected $failure without retaining the queue lock",
    async (failure) => {
      const { id } = await insertAgedQueuedWork({ ageSeconds: 1800 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
      const sweeper = await pool.connect();
      const observer = await pool.connect();
      const read = sweeper.query.bind(sweeper);
      const release = sweeper.release.bind(sweeper);
      const { rows } = await read<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const connectionErrors: unknown[] = [];
      const onError = (error: Error) => {
        connectionErrors.push(error);
      };
      sweeper.on("error", onError);
      let discard = false;
      vi.spyOn(sweeper, "release").mockImplementation((error) => {
        discard = error === true || error instanceof Error;
      });
      const connect = vi.spyOn(pool, "connect").mockImplementationOnce(async () => sweeper);
      vi.spyOn(sweeper, "query").mockImplementation(async (text, values) => {
        if (typeof text === "string" && /UPDATE\s+agent_work_items/i.test(text)) {
          if (failure === "idle timeout") {
            await expect.poll(() => connectionErrors.length).toBeGreaterThan(0);
          } else {
            await read("SELECT FROM");
          }
        }
        return read(text, values);
      });
      try {
        const result = await workState
          .markLostRunningWorkFailed(pool, id, 1200)
          .catch((error: unknown) => error);
        expect(result).toBeInstanceOf(Error);
        if (failure === "idle timeout") {
          expect(connectionErrors).toContainEqual(expect.objectContaining({ code: "25P03" }));
          expect(discard).toBe(true);
        } else {
          expect(result).toMatchObject({ code: "42601" });
        }
        expect(
          (await observer.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows,
        ).toEqual(before.rows);
        expect(
          (
            await observer.query<{ held: boolean }>(
              `SELECT EXISTS (
               SELECT 1 FROM pg_locks
                WHERE pid = $1 AND relation = 'pgboss.job'::regclass
                  AND mode = 'ShareLock' AND granted
             ) AS held`,
              [rows[0]?.pid],
            )
          ).rows[0]?.held,
        ).toBe(false);
        expect(
          (
            await observer.query(
              "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'created', $3::jsonb)",
              [randomUUID(), DESCRIPTION_QUEUE, JSON.stringify({ owner: OWNER })],
            )
          ).rowCount,
        ).toBe(1);
      } finally {
        connect.mockRestore();
        vi.mocked(sweeper.query).mockRestore();
        vi.mocked(sweeper.release).mockRestore();
        sweeper.off("error", onError);
        release(discard);
        observer.release();
      }
    },
  );

  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((workType) =>
      (["renewal", "job revival"] as const).map((revival) => ({ workType, revival })),
    ),
  )("terminal UPDATE survives $revival for $workType", async ({ workType, revival }) => {
    const cfg = makeTestConfig();
    const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
    const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
    await pool.query(
      `UPDATE agent_work_items
          SET type = $2, source = $3, status = 'running', started_at = created_at
        WHERE id = $1`,
      [id, workType, workType === "triage" ? "slash" : "auto"],
    );
    const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
    const token = vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
      token: "synthetic-integration-token",
      expiresAtTs: Date.now() + 60_000,
      ttlMs: 60_000,
    });
    const factory = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
    if (workType === "review") {
      const check = await fake.surface.startReviewCheck("h", id, "Running");
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        detail: { status: "in_progress" },
      });
    }
    let leaseEpoch: number | null = null;
    if (revival === "renewal") {
      const acquisition = await acquirePrActorLease(pool, {
        resourceKey,
        workType,
        workItemId: id,
        holderId: "stale-queue-it",
        ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
      });
      if (!acquisition.acquired) throw new Error("Expected initial lease acquisition");
      leaseEpoch = acquisition.leaseEpoch;
      await pool.query(
        "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE work_item_id = $1",
        [id],
      );
    }
    const snapshot = await collectQueueDiagnostics({
      boss,
      pool,
      now: new Date(),
      diagnosticQueues: [],
      dlqQueues: [],
      lostRunningMinAgeSeconds: minAgeSeconds,
    });
    expect(snapshot.lostRunningWorkItems.map((item) => item.workItemId)).toContain(id);
    const before = await pool.query<{
      status: string;
      last_error: string | null;
      completed_at: Date | null;
      updated_at: Date;
    }>("SELECT status, last_error, completed_at, updated_at FROM agent_work_items WHERE id = $1", [
      id,
    ]);
    const mark = workState.markLostRunningWorkFailed;
    let intercepted = false;
    vi.spyOn(workState, "markLostRunningWorkFailed").mockImplementation(async (...args) => {
      if (!intercepted && args[1] === id) {
        intercepted = true;
        const client = await pool.connect();
        try {
          if (revival === "renewal") {
            if (leaseEpoch == null) throw new Error("Expected acquired epoch");
            expect(
              await renewPrActorLease(client, {
                resourceKey,
                workType,
                workItemId: id,
                leaseEpoch,
                ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
              }),
            ).toBe(true);
          } else {
            const queue = {
              review: REVIEW_QUEUE,
              description: DESCRIPTION_QUEUE,
              triage: TRIAGE_QUEUE,
              verification: VERIFICATION_QUEUE,
            }[workType];
            await client.query(
              "INSERT INTO pgboss.job (id, name, state, data) VALUES ($1, $2, 'active', $3::jsonb)",
              [randomUUID(), queue, JSON.stringify({ owner: OWNER, workItemId: id })],
            );
          }
        } finally {
          client.release();
        }
      }
      return mark(...args);
    });
    await reconcileLostRunningWork({
      cfg,
      pool,
      items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
    });
    expect(intercepted).toBe(true);
    const after = await pool.query(
      "SELECT status, last_error, completed_at, updated_at FROM agent_work_items WHERE id = $1",
      [id],
    );
    expect(after.rows).toEqual(before.rows);
    expect(token).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual([]);
    if (workType !== "review") return;
    if (leaseEpoch == null) {
      leaseEpoch = await inTransaction(pool, async (client) => {
        const acquisition = await acquirePrActorLease(client, {
          resourceKey,
          workType,
          workItemId: id,
          holderId: "stale-queue-it-recovered",
          ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
        });
        if (!acquisition.acquired) throw new Error("Expected resumed lease acquisition");
        expect(await claimWorkForExecution(client, id, acquisition.leaseEpoch)).not.toBeNull();
        return acquisition.leaseEpoch;
      });
    }
    expect(await markWorkCompleted(pool, id, leaseEpoch)).toBe(true);
    await reviewVerdict({
      pool,
      prSurface: fake.surface,
      owner: OWNER,
      repo: "r",
      prNumber: 1,
      workItemId: id,
      resourceKey,
      reviewLens: "review",
      headSha: "h",
      leaseEpoch,
      commitStatusEnabled: false,
    }).close({ kind: "published", findings: [] });
    expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual([
      expect.objectContaining({ conclusion: "success" }),
    ]);
    const completed = await pool.query<{ status: string; detail: { conclusion: string } }>(
      `SELECT w.status, p.detail FROM agent_work_items w
         JOIN publish_records p ON p.work_item_id = w.id AND p.step = 'check_run'
        WHERE w.id = $1`,
      [id],
    );
    expect(completed.rows[0]).toMatchObject({
      status: "completed",
      detail: { status: "completed", conclusion: "success" },
    });
  });

  it.each(
    (["created", "active", "retry"] as const).flatMap((state) =>
      (["id", "singleton", "json"] as const).map((identity) => ({ state, identity })),
    ),
  )(
    "preserves running work with a revived $state job matched only by $identity",
    async ({ state, identity }) => {
      const cfg = makeTestConfig();
      const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      const { id } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const snapshot = await collectQueueDiagnostics({
        boss,
        pool,
        now: new Date(),
        diagnosticQueues: [],
        dlqQueues: [],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      expect(snapshot.lostRunningWorkItems.map((item) => item.workItemId)).toContain(id);
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, singleton_key, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          identity === "id" ? id : randomUUID(),
          REVIEW_QUEUE,
          state,
          identity === "singleton" ? id : null,
          JSON.stringify({ owner: OWNER, ...(identity === "json" ? { workItemId: id } : {}) }),
        ],
      );
      await reconcileLostRunningWork({
        cfg,
        pool,
        items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
      });
      const result = await pool.query(
        "SELECT status, last_error, completed_at FROM agent_work_items WHERE id = $1",
        [id],
      );
      expect(result.rows).toEqual([{ status: "running", last_error: null, completed_at: null }]);
    },
  );

  it.each(["review", "description", "triage", "verification"] as const)(
    "fails truly lost %s work and retries a failed review close",
    async (workType) => {
      const cfg = makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: true },
      });
      const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
      await pool.query(
        `UPDATE agent_work_items
            SET type = $2, source = $3, status = 'running', started_at = created_at
          WHERE id = $1`,
        [id, workType, workType === "triage" ? "slash" : "auto"],
      );
      const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "synthetic-integration-token",
        expiresAtTs: Date.now() + 60_000,
        ttlMs: 60_000,
      });
      const factory = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      const finish = vi.spyOn(fake.surface, "finishReviewCheck");
      if (workType === "review") {
        const check = await fake.surface.startReviewCheck("h", id, "Running");
        await recordReviewCheckRun(pool, {
          workItemId: id,
          resourceKey,
          reviewLens: "review",
          githubId: check.id,
          detail: { status: "in_progress" },
        });
        finish.mockRejectedValueOnce(
          Object.assign(new Error("Synthetic close failure"), { accepted: false }),
        );
      }
      await pool.query(
        `INSERT INTO pgboss.job (id, name, state, data)
         VALUES ($1, $2, 'completed', $3::jsonb), ($4, $5, 'active', $3::jsonb)`,
        [
          randomUUID(),
          {
            review: REVIEW_QUEUE,
            description: DESCRIPTION_QUEUE,
            triage: TRIAGE_QUEUE,
            verification: VERIFICATION_QUEUE,
          }[workType],
          JSON.stringify({ owner: OWNER, workItemId: id }),
          randomUUID(),
          "agent-work-ack",
        ],
      );
      const snapshot = await collectQueueDiagnostics({
        boss,
        pool,
        now: new Date(),
        diagnosticQueues: [],
        dlqQueues: [],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      expect(snapshot.lostRunningWorkItems.map((item) => item.workItemId)).toContain(id);
      await reconcileLostRunningWork({
        cfg,
        pool,
        items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
      });
      const result = await pool.query(
        "SELECT status, last_error, completed_at FROM agent_work_items WHERE id = $1",
        [id],
      );
      expect(result.rows).toEqual([
        { status: "failed", last_error: "worker_lost", completed_at: expect.any(Date) },
      ]);
      if (workType !== "review") {
        expect(factory).not.toHaveBeenCalled();
        return;
      }
      expect(finish).toHaveBeenCalledTimes(1);
      const open = await pool.query<{ detail: { status: string } }>(
        "SELECT detail FROM publish_records WHERE work_item_id = $1 AND step = 'check_run'",
        [id],
      );
      expect(open.rows[0]?.detail.status).toBe("in_progress");
      await reconcileLostRunningWork({ cfg, pool, items: [] });
      expect(finish).toHaveBeenCalledTimes(2);
      expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual([
        expect.objectContaining({ conclusion: "action_required" }),
      ]);
      expect(
        fake.controls.events.filter((event) => event.kind === "setReviewCommitStatus"),
      ).toEqual([expect.objectContaining({ status: expect.objectContaining({ state: "error" }) })]);
      await reconcileLostRunningWork({ cfg, pool, items: snapshot.lostRunningWorkItems });
      expect(finish).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["lock", "admission"] as const)(
    "repairs a terminal verdict deferred by %s without a new work delivery",
    async (mode) => {
      const defaults = makeTestConfig();
      const cfg = makeTestConfig({ features: { ...defaults.features, commitStatus: true } });
      const { id, resourceKey } = await insertAgedQueuedWork();
      await pool.query("UPDATE agent_work_items SET status = 'cancelled' WHERE id = $1", [id]);
      const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "synthetic-integration-token",
        expiresAtTs: Date.now() + 60_000,
        ttlMs: 60_000,
      });
      vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: 111,
        detail: { status: "in_progress" },
      });
      const finish = vi.spyOn(fake.surface, "finishReviewCheck");
      const status = vi.spyOn(fake.surface, "setReviewCommitStatus");
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered: Promise<void>[] = [];
      const holders = Array.from(
        { length: mode === "lock" ? 1 : Math.max(1, Math.floor((pool.options.max ?? 10) / 2)) },
        (_, index) => {
          let enter!: () => void;
          entered.push(
            new Promise<void>((resolve) => {
              enter = resolve;
            }),
          );
          return withOwnVerdictClose(
            pool,
            {
              workItemId: mode === "lock" ? id : randomUUID(),
              resourceKey,
              reviewLens: "review",
              leaseEpoch: null,
            },
            async () => {
              enter();
              await barrier;
              return index;
            },
          );
        },
      );
      try {
        await Promise.all(entered);
        await reviewVerdict({
          pool,
          prSurface: fake.surface,
          owner: OWNER,
          repo: "r",
          prNumber: 1,
          workItemId: id,
          resourceKey,
          reviewLens: "review",
          headSha: "h",
          leaseEpoch: null,
          commitStatusEnabled: cfg.features.commitStatus,
        }).close({ kind: "cancelled" });
        expect(finish).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(
          (await listTerminalReviewsWithOpenOwnChecks(pool)).map((item) => item.workItemId),
        ).toContain(id);
      } finally {
        release();
        await Promise.all(holders);
      }
      await reconcileLostRunningWork({ cfg, pool, items: [] });
      await reconcileLostRunningWork({ cfg, pool, items: [] });
      expect(finish).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "cancelled" }));
      expect(status).toHaveBeenCalledOnce();
      expect(status).toHaveBeenCalledWith("h", expect.objectContaining({ state: "error" }));
      expect(
        (await listTerminalReviewsWithOpenOwnChecks(pool)).map((item) => item.workItemId),
      ).not.toContain(id);
      console.log(
        "own-verdict-deferred-repair",
        JSON.stringify({
          mode,
          finishCalls: finish.mock.calls.length,
          statusCalls: status.mock.calls.length,
        }),
      );
    },
  );

  // Failure modes: denial lost on restart, denied token/metadata polling, a stale
  // denial overriding restored grants, status-only starts missing the repair list,
  // and a deliberate skip becoming evidence.
  it.each([
    "unresolved",
    "blocked",
    "skipped-for-this-run",
    "pending_status_without_check",
  ] as const)(
    "finds pending own-verdict selections only when %s remains applicable",
    async (state) => {
      const { claimOwnVerdict, recordOwnVerdictSurfaceState } =
        await import("../../src/agentWork/publishRecordRepository.js");
      const { id, resourceKey } = await insertAgedQueuedWork();
      await pool.query("UPDATE agent_work_items SET status = 'completed' WHERE id = $1", [id]);
      const identity = {
        workItemId: id,
        resourceKey,
        reviewLens: "review" as const,
        leaseEpoch: null,
      };
      const selected = {
        conclusion: "success" as const,
        summary: "winner",
        status: { headSha: "h", enabled: false, state: "success" as const },
      };
      if (state === "pending_status_without_check") {
        await pool.query(
          `INSERT INTO operation_intents (id, work_item_id, operation_key, mutation_kind, status, detail)
           VALUES ($1, $2, $3, 'github.review_commit_status', 'pending',
                   '{"state":"pending","headSha":"h","__result":null}'::jsonb)`,
          [randomUUID(), id, `review:commit_status:${resourceKey}:h:pending`],
        );
      } else {
        await claimOwnVerdict(pool, { ...identity, selected });
        await recordOwnVerdictSurfaceState(pool, { ...identity, selected }, "check", state);
      }
      const candidates = (await listTerminalReviewsWithOpenOwnChecks(pool)).map(
        (item) => item.workItemId,
      );
      expect(candidates.includes(id)).toBe(state !== "skipped-for-this-run");
      const row = await pool.query(
        "SELECT github_id, detail FROM publish_records WHERE work_item_id = $1",
        [id],
      );
      if (state === "pending_status_without_check") {
        expect(row.rows).toEqual([]);
        const { createReviewCapabilityPolicy, availableInstallationCapabilities } =
          await import("../../src/github/installationCapabilities.js");
        const available = availableInstallationCapabilities({
          appId: makeTestConfig().github.appId,
          installationId: 1,
          owner: OWNER,
          repo: "r",
        });
        const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
        Object.defineProperty(fake.surface, "capabilities", {
          value: createReviewCapabilityPolicy({
            ...available,
            availability: {
              ...available.availability,
              checksRead: "denied",
              checksWrite: "denied",
            },
          }),
        });
        await reviewVerdict({
          ...identity,
          pool,
          prSurface: fake.surface,
          owner: OWNER,
          repo: "r",
          prNumber: 1,
          headSha: "h",
          commitStatusEnabled: false,
        }).repairIfOpen();
        expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual(
          [],
        );
        expect(
          fake.controls.events.filter((event) => event.kind === "setReviewCommitStatus"),
        ).toEqual([
          expect.objectContaining({ status: expect.objectContaining({ state: "error" }) }),
        ]);
        expect(
          (await listTerminalReviewsWithOpenOwnChecks(pool)).map((item) => item.workItemId),
        ).not.toContain(id);
        return;
      }
      expect(row.rows[0].github_id).toBeNull();
      expect(row.rows[0].detail.ownCheckApplied).toBeUndefined();
      expect(row.rows[0].detail.conclusion).toBeUndefined();
      if (state === "blocked") {
        const {
          saveGithubCapabilityObservation,
          loadGithubCapabilityObservation,
          recordGithubCapabilityDenial,
        } = await import("../../src/agentWork/githubCapabilityRepository.js");
        const { availableInstallationCapabilities } =
          await import("../../src/github/installationCapabilities.js");
        const availability = availableInstallationCapabilities({
          appId: makeTestConfig().github.appId,
          installationId: 1,
          owner: OWNER,
          repo: "r",
        }).availability;
        await recordReviewCheckRun(pool, {
          ...identity,
          githubId: 111,
          detail: { status: "in_progress" },
        });
        await saveGithubCapabilityObservation(pool, {
          installationId: 1,
          owner: OWNER,
          repo: "r",
          observation: {
            generation: 1,
            capabilities: availability,
          },
        });
        try {
          const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
          vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
            token: "synthetic-integration-token",
            expiresAtTs: Date.now() + 60_000,
            ttlMs: 60_000,
          });
          vi.spyOn(prSurface, "createPrSurface").mockImplementation((params) => {
            Object.defineProperty(fake.surface, "capabilities", {
              value: params.capabilities,
              configurable: true,
            });
            return fake.surface;
          });
          const finish = vi
            .spyOn(fake.surface, "finishReviewCheck")
            .mockImplementationOnce(async () => {
              await fake.surface.capabilities?.deny("checksWrite");
              throw Object.assign(new Error("Resource not accessible by integration"), {
                status: 403,
                accepted: false,
              });
            });
          await reconcileLostRunningWork({ cfg: makeTestConfig(), pool, items: [] });
          expect(
            (
              await loadGithubCapabilityObservation(pool, {
                installationId: 1,
                owner: OWNER,
                repo: "r",
              })
            )?.capabilities.checksWrite,
          ).toBe("denied");
          // A blocked candidate must not occupy the bounded repair batch.
          expect(
            (await listTerminalReviewsWithOpenOwnChecks(pool)).map((item) => item.workItemId),
          ).not.toContain(id);
          const restarts = Array.from({ length: 2 }, () =>
            spawnSync(
              "nub",
              [
                "-e",
                `
            const { Pool } = await import("pg");
            const { productionInstallationSurface } = await import("./src/agentWork/installationSurface.ts");
            const { reconcileLostRunningWork } = await import("./src/agentWork/lostRunningWork.ts");
            const { makeTestConfig } = await import("./test/helpers/config.ts");
            let tokenCalls = 0, surfaceCalls = 0;
            productionInstallationSurface.token = async () => { tokenCalls++; throw new Error("Denied token polling"); };
            productionInstallationSurface.create = async () => { surfaceCalls++; throw new Error("Denied surface polling"); };
            const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
            try {
              await reconcileLostRunningWork({ cfg: makeTestConfig(), pool, items: [] });
              console.log(JSON.stringify({ pid: process.pid, tokenCalls, surfaceCalls }));
            } finally { await pool.end(); }
          `,
              ],
              { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
            ),
          );
          const pids: number[] = [];
          for (const restart of restarts) {
            expect(restart.error).toBeUndefined();
            expect(restart.status).toBe(0);
            const evidence = JSON.parse(restart.stdout.trim());
            expect(evidence).toMatchObject({ tokenCalls: 0, surfaceCalls: 0 });
            expect(evidence.pid).not.toBe(process.pid);
            pids.push(evidence.pid);
          }
          expect(new Set(pids).size).toBe(2);
          await saveGithubCapabilityObservation(pool, {
            installationId: 1,
            owner: OWNER,
            repo: "r",
            observation: { generation: 2, capabilities: availability },
          });
          await recordGithubCapabilityDenial(pool, {
            installationId: 1,
            owner: OWNER,
            repo: "r",
            generation: 1,
            operation: "checksWrite",
          });
          expect(
            (
              await loadGithubCapabilityObservation(pool, {
                installationId: 1,
                owner: OWNER,
                repo: "r",
              })
            )?.capabilities.checksWrite,
          ).toBe("available");
          await reconcileLostRunningWork({ cfg: makeTestConfig(), pool, items: [] });
          expect(
            fake.controls.events.filter((event) => event.kind === "finishReviewCheck"),
          ).toEqual([expect.objectContaining({ conclusion: "success" })]);
          expect(finish).toHaveBeenLastCalledWith(
            expect.objectContaining({ conclusion: "success", summary: "winner" }),
          );
          expect(
            (await listTerminalReviewsWithOpenOwnChecks(pool)).map((item) => item.workItemId),
          ).not.toContain(id);
          console.info("own-verdict-denial-restart-repair", {
            processes: pids.length,
            deniedTokenCalls: 0,
            deniedSurfaceCalls: 0,
            repaired: true,
          });
        } finally {
          await pool.query(
            "DELETE FROM github_repository_capabilities WHERE installation_id = 1 AND owner = $1 AND repo = 'r'",
            [OWNER],
          );
        }
      }
    },
  );

  it.each(["completed", "cancelled", "superseded", "failed", "cancel_requested"] as const)(
    "does not close or overwrite a candidate changed to %s after detection",
    async (status) => {
      const cfg = makeTestConfig();
      const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
      const { id, resourceKey } = await insertAgedQueuedWork({ ageSeconds: minAgeSeconds + 60 });
      await pool.query(
        "UPDATE agent_work_items SET status = 'running', started_at = created_at WHERE id = $1",
        [id],
      );
      const fake = prSurface.createFakePrSurface({ owner: OWNER, repo: "r", prNumber: 1 });
      vi.spyOn(installationToken, "mintInstallationToken").mockResolvedValue({
        token: "synthetic-integration-token",
        expiresAtTs: Date.now() + 60_000,
        ttlMs: 60_000,
      });
      const factory = vi.spyOn(prSurface, "createPrSurface").mockReturnValue(fake.surface);
      const check = await fake.surface.startReviewCheck("h", id, "Running");
      await recordReviewCheckRun(pool, {
        workItemId: id,
        resourceKey,
        reviewLens: "review",
        githubId: check.id,
        detail: { status: "in_progress" },
      });
      const snapshot = await collectQueueDiagnostics({
        boss,
        pool,
        now: new Date(),
        diagnosticQueues: [],
        dlqQueues: [],
        lostRunningMinAgeSeconds: minAgeSeconds,
      });
      expect(snapshot.lostRunningWorkItems.map((item) => item.workItemId)).toContain(id);
      if (status === "cancel_requested") {
        await pool.query("UPDATE agent_work_items SET cancel_requested_at = now() WHERE id = $1", [
          id,
        ]);
      } else {
        await pool.query("UPDATE agent_work_items SET status = $2 WHERE id = $1", [id, status]);
      }
      const before = await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id]);
      await reconcileLostRunningWork({
        cfg,
        pool,
        items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
      });
      expect((await pool.query("SELECT * FROM agent_work_items WHERE id = $1", [id])).rows).toEqual(
        before.rows,
      );
      expect(factory).not.toHaveBeenCalled();
      expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual(
        [],
      );
      if (status === "failed") {
        await reconcileLostRunningWork({ cfg, pool, items: [] });
        expect(fake.controls.events.filter((event) => event.kind === "finishReviewCheck")).toEqual([
          expect.objectContaining({ conclusion: "action_required" }),
        ]);
      }
    },
  );

  it("uses current mark time for an expired lease changed after an older snapshot", async () => {
    const cfg = makeTestConfig();
    const minAgeSeconds = cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
    const now = new Date(Date.now() - 60_000);
    const { id, resourceKey } = await insertAgedQueuedWork({
      ageSeconds: minAgeSeconds + 60,
      now,
    });
    await pool.query(
      "UPDATE agent_work_items SET type = 'description', status = 'running', started_at = created_at WHERE id = $1",
      [id],
    );
    await acquirePrActorLease(pool, {
      resourceKey,
      workType: "description",
      workItemId: id,
      holderId: "stale-queue-it",
      ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
    });
    await pool.query(
      "UPDATE pr_actor_leases SET expires_at = $2::timestamptz - interval '1 second' WHERE work_item_id = $1",
      [id, now.toISOString()],
    );
    const snapshot = await collectQueueDiagnostics({
      boss,
      pool,
      now,
      diagnosticQueues: [],
      dlqQueues: [],
      lostRunningMinAgeSeconds: minAgeSeconds,
    });
    expect(snapshot.lostRunningWorkItems.map((item) => item.workItemId)).toContain(id);
    await pool.query(
      "UPDATE pr_actor_leases SET expires_at = now() - interval '1 second' WHERE work_item_id = $1",
      [id],
    );
    await reconcileLostRunningWork({
      cfg,
      pool,
      items: snapshot.lostRunningWorkItems.filter((item) => item.workItemId === id),
    });
    expect(
      (await pool.query("SELECT status, last_error FROM agent_work_items WHERE id = $1", [id]))
        .rows,
    ).toEqual([{ status: "failed", last_error: "worker_lost" }]);
  });
});
