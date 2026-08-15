import type { Pool, PoolClient } from "pg";
import { queryOne } from "../db/postgres.js";
import { AppError } from "../errors/appError.js";
import type { WorkType } from "./types.js";

/** Seconds a lease-blocked delivery waits before its deferred copy retries acquisition. */
export const PR_ACTOR_LEASE_DEFER_SECONDS = 15;

export type PrActorLeaseKey = {
  readonly resourceKey: string;
  readonly workType: WorkType;
};

export type PrActorLeaseAcquisition =
  | { readonly acquired: true; readonly leaseEpoch: number }
  | {
      readonly acquired: false;
      /** Advisory only (read after the atomic attempt misses); drives log fields and deferral. */
      readonly heldByWorkItemId: string | null;
      readonly leaseEpoch: number;
    };

/**
 * Single atomic admission decision: insert epoch 1 for a never-leased key, or steal
 * from a released (`work_item_id IS NULL`) or lapsed holder. No returned row means
 * the lease is currently held by a live holder.
 */
export async function acquirePrActorLease(
  db: Pool | PoolClient,
  params: PrActorLeaseKey & {
    readonly workItemId: string;
    readonly holderId: string;
    readonly ttlSeconds: number;
  },
): Promise<PrActorLeaseAcquisition> {
  const acquired = await queryOne<{ lease_epoch: string | number }>(
    db,
    `INSERT INTO pr_actor_leases AS l (resource_key, work_type, lease_epoch, work_item_id, holder_id,
                                       acquired_at, renewed_at, expires_at)
     VALUES ($1, $2, 1, $3, $4, now(), now(), now() + ($5 * interval '1 second'))
     ON CONFLICT (resource_key, work_type) DO UPDATE
       SET lease_epoch  = l.lease_epoch + 1,
           work_item_id = EXCLUDED.work_item_id,
           holder_id    = EXCLUDED.holder_id,
           acquired_at  = now(),
           renewed_at   = now(),
           expires_at   = EXCLUDED.expires_at
     WHERE l.work_item_id IS NULL OR l.expires_at <= now()
     RETURNING lease_epoch`,
    [params.resourceKey, params.workType, params.workItemId, params.holderId, params.ttlSeconds],
  );
  if (acquired) {
    return { acquired: true, leaseEpoch: Number(acquired.lease_epoch) };
  }
  const holder = await queryOne<{ work_item_id: string | null; lease_epoch: string | number }>(
    db,
    `SELECT work_item_id, lease_epoch
       FROM pr_actor_leases
      WHERE resource_key = $1 AND work_type = $2`,
    [params.resourceKey, params.workType],
  );
  return {
    acquired: false,
    heldByWorkItemId: holder?.work_item_id ?? null,
    leaseEpoch: Number(holder?.lease_epoch ?? 0),
  };
}

/** Extend the deadline for the caller's epoch; false when a newer epoch owns the key. */
export async function renewPrActorLease(
  db: Pool | PoolClient,
  params: PrActorLeaseKey & { readonly leaseEpoch: number; readonly ttlSeconds: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE pr_actor_leases
        SET renewed_at = now(),
            expires_at = now() + ($4 * interval '1 second')
      WHERE resource_key = $1
        AND work_type = $2
        AND lease_epoch = $3`,
    [params.resourceKey, params.workType, params.leaseEpoch, params.ttlSeconds],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Clear the holder in place for the caller's epoch. The row is never deleted so the
 * epoch stays monotonic; a stale holder cannot clear a live lease.
 */
export async function releasePrActorLease(
  db: Pool | PoolClient,
  params: PrActorLeaseKey & { readonly leaseEpoch: number },
): Promise<void> {
  await db.query(
    `UPDATE pr_actor_leases
        SET work_item_id = NULL,
            holder_id = NULL,
            expires_at = now()
      WHERE resource_key = $1
        AND work_type = $2
        AND lease_epoch = $3`,
    [params.resourceKey, params.workType, params.leaseEpoch],
  );
}

/** True while this holder's epoch still owns the lease for the work item. */
export async function isPrActorLeaseHeld(
  db: Pool | PoolClient,
  workItemId: string,
  leaseEpoch: number,
): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    db,
    `SELECT 1 AS ok
       FROM pr_actor_leases
      WHERE work_item_id = $1
        AND lease_epoch = $2`,
    [workItemId, leaseEpoch],
  );
  return row != null;
}

/** Fencing check before any durable write or GitHub mutation from a leased execution. */
export async function assertPrActorLeaseHeld(
  db: Pool | PoolClient,
  workItemId: string,
  leaseEpoch: number,
): Promise<void> {
  if (await isPrActorLeaseHeld(db, workItemId, leaseEpoch)) return;
  throw new AppError({
    code: "agent_work.pr_actor_lease_lost",
    message: "PR actor lease is no longer held by this execution",
    context: { workItemId, leaseEpoch },
  });
}
