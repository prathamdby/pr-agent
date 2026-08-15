import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../../src/db/migrations.js";
import {
  acquirePrActorLease,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  releasePrActorLease,
  renewPrActorLease,
} from "../../src/agentWork/prActorLease.js";
import {
  claimWorkForExecution,
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
       VALUES ($1, 'review', 'auto', 'queued', $2, 'r', 1, 1, 'h', 'review', $3, '{}'::jsonb)`,
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
    const { rows: deadPayload } = await pool.query<{ payload: { publishDegraded?: boolean } }>(
      `SELECT payload FROM agent_work_items WHERE id = $1`,
      [deadWorkerItem],
    );
    expect(deadPayload[0]?.payload.publishDegraded).toBeUndefined();

    await markWorkPublishDegraded(pool, successorItem, 2);
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
        leaseEpoch: 99,
        ttlSeconds: TTL_SECONDS,
      }),
    ).resolves.toBe(false);

    await expect(
      renewPrActorLease(pool, {
        resourceKey,
        workType: "review",
        leaseEpoch: 1,
        ttlSeconds: TTL_SECONDS * 2,
      }),
    ).resolves.toBe(true);
    expect((await getLeaseRow(resourceKey)).expires_at.getTime()).toBeGreaterThan(before.getTime());
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
});
