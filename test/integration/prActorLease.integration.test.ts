import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import * as evlog from "../../src/evlog.js";
import {
  acquirePrActorLease,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  releasePrActorLease,
  releasePrActorLeaseHeldByWorkItems,
  renewPrActorLease,
} from "../../src/agentWork/prActorLease.js";
import { createReviewRescheduleWorkItem } from "../../src/agentWork/reviewReschedule.js";
import { cancelActiveReviews } from "../../src/agentWork/intake/workItemRepository.js";
import {
  claimWorkForExecution,
  getWorkItem,
  markWorkCompleted,
  markWorkPublishDegraded,
  updateRunningWorkHeadSha,
} from "../../src/agentWork/repository.js";
import { hasDatabase, integrationPool } from "./db.js";

const OWNER = "lease-it";
const TTL_SECONDS = 900;

type LeaseRow = {
  readonly lease_epoch: string | number;
  readonly work_item_id: string | null;
  readonly holder_id: string | null;
  readonly expires_at: Date;
};

describe.skipIf(!hasDatabase)("PR actor lease (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query("DELETE FROM pr_actor_leases WHERE resource_key LIKE $1", [`${OWNER}/%`]);
    await pool.query("DELETE FROM agent_work_items WHERE owner = $1", [OWNER]);
  });

  async function insertRunningWorkItem(resourceKey: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload
       )
       VALUES (
         $1, 'review', 'auto', 'queued', $2, 'r', 1, 1, 'h', 'review', $3,
         '{"mode":"review","source":"auto"}'::jsonb
       )`,
      [id, OWNER, resourceKey],
    );
    await claimWorkForExecution(pool, id);
    return id;
  }

  async function getLeaseRow(resourceKey: string): Promise<LeaseRow> {
    const { rows } = await pool.query<LeaseRow>(
      `SELECT lease_epoch, work_item_id, holder_id, expires_at
         FROM pr_actor_leases
        WHERE resource_key = $1 AND work_type = 'review'`,
      [resourceKey],
    );
    const row = rows[0];
    if (!row) throw new Error(`missing lease row for ${resourceKey}`);
    return row;
  }

  function acquire(resourceKey: string, workItemId: string) {
    return acquirePrActorLease(pool, {
      resourceKey,
      workType: "review",
      workItemId,
      holderId: "lease-it-holder",
      ttlSeconds: TTL_SECONDS,
    });
  }

  it("admits exactly one holder per (resource key, work type) under concurrency", async () => {
    const resourceKey = `${OWNER}/race-${randomUUID().slice(0, 8)}#1`;
    const contenders = Array.from({ length: 8 }, () => randomUUID());

    const outcomes = await Promise.all(contenders.map((id) => acquire(resourceKey, id)));

    const winners = outcomes.filter((outcome) => outcome.acquired);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.leaseEpoch).toBe(1);

    const row = await getLeaseRow(resourceKey);
    expect(Number(row.lease_epoch)).toBe(1);
    expect(contenders).toContain(row.work_item_id);
  });

  it("hands the lease to the next work item only after release, bumping the epoch", async () => {
    const resourceKey = `${OWNER}/handoff-${randomUUID().slice(0, 8)}#1`;
    const first = randomUUID();
    const second = randomUUID();

    await expect(acquire(resourceKey, first)).resolves.toEqual({ acquired: true, leaseEpoch: 1 });

    const blocked = await acquire(resourceKey, second);
    expect(blocked).toEqual({ acquired: false, heldByWorkItemId: first, leaseEpoch: 1 });

    await releasePrActorLease(pool, {
      resourceKey,
      workType: "review",
      leaseEpoch: 1,
    });

    await expect(acquire(resourceKey, second)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await expect(isPrActorLeaseHeld(pool, first, 1)).resolves.toBe(false);
    await expect(isPrActorLeaseHeld(pool, second, 2)).resolves.toBe(true);
  });

  it("steals a lapsed lease and fences the dead holder out of durable writes", async () => {
    const logWarn = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
    const resourceKey = `${OWNER}/lapse-${randomUUID().slice(0, 8)}#1`;
    const deadWorkerItem = await insertRunningWorkItem(resourceKey);
    const successorItem = await insertRunningWorkItem(resourceKey);

    const dead = await acquire(resourceKey, deadWorkerItem);
    if (!dead.acquired) throw new Error("expected first acquisition to succeed");
    await pool.query(
      `UPDATE pr_actor_leases SET expires_at = now() - interval '1 second'
        WHERE resource_key = $1 AND work_type = 'review'`,
      [resourceKey],
    );

    await expect(acquire(resourceKey, successorItem)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });

    await expect(markWorkCompleted(pool, deadWorkerItem, dead.leaseEpoch)).resolves.toBe(false);
    await expect(
      updateRunningWorkHeadSha(pool, deadWorkerItem, "newhead", dead.leaseEpoch),
    ).resolves.toBe(false);
    await expect(
      assertPrActorLeaseHeld(pool, deadWorkerItem, dead.leaseEpoch),
    ).rejects.toMatchObject({ code: "agent_work.pr_actor_lease_lost" });

    await markWorkPublishDegraded(pool, deadWorkerItem, dead.leaseEpoch);
    expect(logWarn).toHaveBeenCalledExactlyOnceWith("agent_work_publish_degraded_mark_rejected", {
      workItemId: deadWorkerItem,
      leaseEpoch: dead.leaseEpoch,
      rowCount: 0,
    });
    const { rows: deadPayload } = await pool.query<{ payload: { publishDegraded?: boolean } }>(
      `SELECT payload FROM agent_work_items WHERE id = $1`,
      [deadWorkerItem],
    );
    expect(deadPayload[0]?.payload.publishDegraded).toBeUndefined();

    await markWorkPublishDegraded(pool, successorItem, 2);
    expect(logWarn).toHaveBeenCalledTimes(1);
    const { rows: livePayload } = await pool.query<{ payload: { publishDegraded?: boolean } }>(
      `SELECT payload FROM agent_work_items WHERE id = $1`,
      [successorItem],
    );
    expect(livePayload[0]?.payload.publishDegraded).toBe(true);

    await expect(markWorkCompleted(pool, successorItem, 2)).resolves.toBe(true);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_work_items WHERE id = $1`,
      [successorItem],
    );
    expect(rows[0]?.status).toBe("completed");
  });

  it("renews only while the caller's epoch still owns the lease", async () => {
    const resourceKey = `${OWNER}/renew-${randomUUID().slice(0, 8)}#1`;
    const holder = randomUUID();

    await acquire(resourceKey, holder);
    const before = (await getLeaseRow(resourceKey)).expires_at;

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: holder,
        leaseEpoch: 99,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId: holder,
        leaseEpoch: 1,
        ttlSeconds: TTL_SECONDS * 2,
      }),
    ).resolves.toBe(true);
    expect((await getLeaseRow(resourceKey)).expires_at.getTime()).toBeGreaterThan(before.getTime());
  });

  it("does not renew after the holder is cleared for the same epoch", async () => {
    const resourceKey = `${OWNER}/renew-cleared-${randomUUID().slice(0, 8)}#1`;
    const workItemId = randomUUID();

    await acquire(resourceKey, workItemId);
    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId,
        leaseEpoch: 1,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);
    expect((await getLeaseRow(resourceKey)).work_item_id).toBeNull();
    expect(Number((await getLeaseRow(resourceKey)).lease_epoch)).toBe(1);
  });

  it("keeps epochs monotonic across release so a stale holder cannot clear a live lease", async () => {
    const resourceKey = `${OWNER}/monotonic-${randomUUID().slice(0, 8)}#1`;
    const first = randomUUID();
    const second = randomUUID();

    await acquire(resourceKey, first);
    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });
    await acquire(resourceKey, second);

    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });

    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(second);
    expect(Number(row.lease_epoch)).toBe(2);
  });

  it("holds the lease-row lock until the stale-head handoff transaction commits", async () => {
    const resourceKey = `${OWNER}/locked-handoff-${randomUUID().slice(0, 8)}#1`;
    const parentId = await insertRunningWorkItem(resourceKey);
    const successorId = await insertRunningWorkItem(resourceKey);
    const acquisition = await acquire(resourceKey, parentId);
    if (!acquisition.acquired) throw new Error("expected parent lease acquisition to succeed");
    await pool.query(
      `UPDATE pr_actor_leases
          SET expires_at = now() - interval '1 second'
        WHERE resource_key = $1 AND work_type = 'review'`,
      [resourceKey],
    );
    const parent = await getWorkItem(pool, parentId);
    if (parent?.type !== "review") throw new Error("expected review parent");

    const blocker = await pool.connect();
    const contender = await pool.connect();
    const observer = await pool.connect();
    let blockerOpen = false;
    let handoff: ReturnType<typeof createReviewRescheduleWorkItem> | undefined;
    let takeover: ReturnType<typeof acquirePrActorLease> | undefined;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT id FROM agent_work_items WHERE id = $1 FOR UPDATE", [parentId]);

      handoff = createReviewRescheduleWorkItem(pool, parent, acquisition.leaseEpoch);
      await expect
        .poll(async () => {
          const { rows } = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%SELECT id FROM agent_work_items%'`,
          );
          return rows[0]?.count ?? 0;
        })
        .toBeGreaterThan(0);

      const { rows: contenderRows } = await contender.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const contenderPid = contenderRows[0]?.pid;
      if (contenderPid == null) throw new Error("missing contender backend pid");
      takeover = acquirePrActorLease(contender, {
        resourceKey,
        workType: "review",
        workItemId: successorId,
        holderId: "lease-it-successor",
        ttlSeconds: TTL_SECONDS,
      });

      await expect
        .poll(async () => {
          const { rows } = await observer.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [contenderPid],
          );
          return rows[0]?.wait_event_type;
        })
        .toBe("Lock");

      await blocker.query("COMMIT");
      blockerOpen = false;
      await expect(handoff).resolves.toMatchObject({
        replacementWorkItemId: expect.any(String),
      });
      await expect(takeover).resolves.toEqual({ acquired: true, leaseEpoch: 2 });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      await handoff?.catch(() => undefined);
      await takeover?.catch(() => undefined);
      blocker.release();
      contender.release();
      observer.release();
    }
  });

  it("records the acquired epoch on the work item row at claim time", async () => {
    const resourceKey = `${OWNER}/record-${randomUUID().slice(0, 8)}#1`;
    const workItemId = await insertRunningWorkItem(resourceKey);
    const acquisition = await acquire(resourceKey, workItemId);
    if (!acquisition.acquired) throw new Error("expected acquisition to succeed");

    await expect(
      claimWorkForExecution(pool, workItemId, acquisition.leaseEpoch),
    ).resolves.toMatchObject({ attemptCount: 2 });
    const { rows } = await pool.query<{ execution_epoch: string | number }>(
      `SELECT execution_epoch FROM agent_work_items WHERE id = $1`,
      [workItemId],
    );
    expect(Number(rows[0]?.execution_epoch)).toBe(acquisition.leaseEpoch);

    // Unleased callers omit the epoch and leave the record untouched.
    await pool.query(`UPDATE agent_work_items SET execution_epoch = 9 WHERE id = $1`, [workItemId]);
    await claimWorkForExecution(pool, workItemId);
    const { rows: kept } = await pool.query<{ execution_epoch: string | number }>(
      `SELECT execution_epoch FROM agent_work_items WHERE id = $1`,
      [workItemId],
    );
    expect(Number(kept[0]?.execution_epoch)).toBe(9);
  });

  it("refuses a stale predecessor release when the replacement reused its identifier (#660)", async () => {
    // The TLC id-reuse kill trace, replayed against real Postgres:
    // Cancel(dead ids) snapshots pairs [(D,5)]; the replacement reuses D's id
    // and acquires epoch 6; the late release with the stale pairs must leave
    // the live epoch held with renewal and fencing intact.
    const resourceKey = `${OWNER}/reuse-${randomUUID().slice(0, 8)}#1`;
    const workItemId = randomUUID();
    await pool.query(
      `INSERT INTO agent_work_items (
         id, type, source, status, owner, repo, pr_number, installation_id,
         head_sha, review_lens, resource_key, payload, execution_epoch
       )
       VALUES (
         $1, 'review', 'auto', 'running', $2, 'r', 1, 1, 'h', 'review', $3,
         '{"mode":"review","source":"auto"}'::jsonb, 5
       )`,
      [workItemId, OWNER, resourceKey],
    );

    await expect(acquire(resourceKey, workItemId)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });
    // Predecessor epoch on the cancelled row is 5 in the model; drive the
    // lease to a matching shape: release the initial holder, then let the
    // same identifier acquire the newer epoch the stale cancel must not clear.
    await releasePrActorLease(pool, { resourceKey, workType: "review", leaseEpoch: 1 });
    await pool.query(`UPDATE agent_work_items SET execution_epoch = 5 WHERE id = $1`, [workItemId]);
    // A stale cancel snapshot taken before the replacement acquires.
    const stalePairs = [{ workItemId, leaseEpoch: 5 }];

    await expect(acquire(resourceKey, workItemId)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await pool.query(`UPDATE agent_work_items SET execution_epoch = 2 WHERE id = $1`, [workItemId]);

    // The exact-pairs release with the stale predecessor epoch refuses the kill.
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: stalePairs,
    });
    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(workItemId);
    expect(Number(row.lease_epoch)).toBe(2);
    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        workItemId,
        leaseEpoch: 2,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(true);
    await expect(assertPrActorLeaseHeld(pool, workItemId, 2)).resolves.toBeUndefined();
    await expect(isPrActorLeaseHeld(pool, workItemId, 2)).resolves.toBe(true);
  });

  it("clears the holder on an exact (id, epoch) match and skips unknown epochs", async () => {
    const resourceKey = `${OWNER}/pairs-${randomUUID().slice(0, 8)}#1`;
    const holder = randomUUID();
    const other = randomUUID();

    await expect(acquire(resourceKey, holder)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });

    // A non-matching epoch for the same id never clears (newer survives).
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: [{ workItemId: holder, leaseEpoch: 99 }],
    });
    expect((await getLeaseRow(resourceKey)).work_item_id).toBe(holder);

    // A matching pair clears (genuine holder cleanup never waits out the TTL).
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: [
        { workItemId: other, leaseEpoch: 7 },
        { workItemId: holder, leaseEpoch: 1 },
      ],
    });
    expect((await getLeaseRow(resourceKey)).work_item_id).toBeNull();

    // Empty holders skip the UPDATE entirely (fail closed to TTL/watchdog).
    await expect(acquire(resourceKey, other)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 2,
    });
    await releasePrActorLeaseHeldByWorkItems(pool, {
      resourceKey,
      workType: "review",
      holders: [],
    });
    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(other);
    expect(Number(row.lease_epoch)).toBe(2);
  });

  it("cancelActiveReviews clears on exact pairs and fails closed on unknown epochs", async () => {
    const resourceKey = `${OWNER}/cancel-${randomUUID().slice(0, 8)}#1`;
    const known = await insertRunningWorkItem(resourceKey);

    const acquisition = await acquire(resourceKey, known);
    if (!acquisition.acquired) throw new Error("expected acquisition to succeed");
    await claimWorkForExecution(pool, known, acquisition.leaseEpoch);

    const client = await pool.connect();
    try {
      const cancelled = await cancelActiveReviews(client, resourceKey, { kind: "closed" as const });
      expect(cancelled.map((row) => row.id)).toEqual([known]);
    } finally {
      client.release();
    }

    // The known holder's exact pair cleared the lease (handoff intact).
    expect((await getLeaseRow(resourceKey)).work_item_id).toBeNull();
  });

  it("cancelActiveReviews fails closed when the holder predates epoch recording", async () => {
    // Pre-fix row: acquired before the claim path recorded execution_epoch,
    // so the row still carries 0 (unknown). The cancel must skip the lease
    // UPDATE rather than clear blindly; expiry plus the watchdog recover it.
    const resourceKey = `${OWNER}/cancel-legacy-${randomUUID().slice(0, 8)}#1`;
    const legacy = await insertRunningWorkItem(resourceKey);
    await expect(acquire(resourceKey, legacy)).resolves.toEqual({
      acquired: true,
      leaseEpoch: 1,
    });
    // No claim-with-epoch: execution_epoch stays 0 as on pre-fix rows.

    const client = await pool.connect();
    try {
      const cancelled = await cancelActiveReviews(client, resourceKey, { kind: "closed" as const });
      expect(cancelled.map((row) => row.id)).toEqual([legacy]);
    } finally {
      client.release();
    }

    const row = await getLeaseRow(resourceKey);
    expect(row.work_item_id).toBe(legacy);
    expect(Number(row.lease_epoch)).toBe(1);
  });
});
