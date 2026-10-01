import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { createStartedBoss, ensureAgentQueues, stopBoss } from "../../src/agentWork/boss.js";
import {
  acquirePrActorLease,
  PR_ACTOR_LEASE_DEFER_SECONDS,
  renewPrActorLease,
} from "../../src/agentWork/prActorLease.js";
import { closeOwnVerdict } from "../../src/agentWork/closeOwnVerdict.js";
import { reconcileLostRunningWork } from "../../src/agentWork/lostRunningWork.js";
import {
  claimWorkForExecution,
  markWorkCompleted,
  recordReviewCheckRun,
} from "../../src/agentWork/repository.js";
import { collectQueueDiagnostics } from "../../src/agentWork/workerHealth.js";
import { runMigrations } from "../../src/db/migrations.js";
import { inTransaction } from "../../src/db/postgres.js";
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

  it.each(
    (["review", "description", "triage", "verification"] as const).flatMap((workType) =>
      (["renewal", "job revival"] as const).map((revival) => ({ workType, revival })),
    ),
  )("terminal UPDATE survives $revival for $workType", async ({ workType, revival }) => {
    const cfg = makeTestConfig();
    const minAgeSeconds = cfg.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
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
        ttlSeconds: cfg.prActorLeaseTtlSeconds,
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
    const query = pool.query.bind(pool);
    let intercepted = false;
    vi.spyOn(pool, "query").mockImplementation(async (text, values) => {
      if (
        !intercepted &&
        typeof text === "string" &&
        /UPDATE\s+agent_work_items/i.test(text) &&
        values?.[0] === id
      ) {
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
                ttlSeconds: cfg.prActorLeaseTtlSeconds,
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
      return query(text, values);
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
          ttlSeconds: cfg.prActorLeaseTtlSeconds,
        });
        if (!acquisition.acquired) throw new Error("Expected resumed lease acquisition");
        expect(await claimWorkForExecution(client, id, acquisition.leaseEpoch)).not.toBeNull();
        return acquisition.leaseEpoch;
      });
    }
    expect(await markWorkCompleted(pool, id, leaseEpoch)).toBe(true);
    await closeOwnVerdict({
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
      outcome: { kind: "published", findings: [] },
    });
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
      const minAgeSeconds = cfg.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
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
      const minAgeSeconds = cfg.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
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

  it.each(["completed", "cancelled", "superseded", "failed", "cancel_requested"] as const)(
    "does not close or overwrite a candidate changed to %s after detection",
    async (status) => {
      const cfg = makeTestConfig();
      const minAgeSeconds = cfg.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
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
    const minAgeSeconds = cfg.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS;
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
      ttlSeconds: cfg.prActorLeaseTtlSeconds,
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
