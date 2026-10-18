import type { Pool, PoolClient } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { queryOne } from "../db/postgres.ts";
import { AppError } from "../errors/appError.ts";
import type { WorkType } from "./types.ts";

export const PR_ACTOR_LEASE_DEFER_SECONDS = 15;

export type PrActorLeaseKey = {
  readonly resourceKey: string;
  readonly workType: WorkType;
};

export type PrActorLeaseAcquisition =
  | { readonly acquired: true; readonly leaseEpoch: number }
  | {
      readonly acquired: false;
      readonly heldByWorkItemId: string | null;
      readonly leaseEpoch: number;
    };

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

export async function renewPrActorLease(
  db: Pool | PoolClient,
  params: PrActorLeaseKey & {
    readonly leaseEpoch: number;
    readonly ttlSeconds: number;
    readonly workItemId: string;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE pr_actor_leases
        SET renewed_at = now(),
            expires_at = now() + ($4 * interval '1 second')
      WHERE resource_key = $1
        AND work_type = $2
        AND lease_epoch = $3
        AND work_item_id = $5`,
    [params.resourceKey, params.workType, params.leaseEpoch, params.ttlSeconds, params.workItemId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type PrActorLeaseHolder = {
  readonly workItemId: string;
  readonly leaseEpoch: number;
};

export async function releasePrActorLeaseHeldByWorkItems(
  db: Pool | PoolClient,
  params: PrActorLeaseKey & { readonly holders: readonly PrActorLeaseHolder[] },
): Promise<void> {
  if (params.holders.length === 0) return;
  await db.query(
    `UPDATE pr_actor_leases AS l
        SET work_item_id = NULL,
            holder_id = NULL,
            expires_at = now()
      WHERE l.resource_key = $1
        AND l.work_type = $2
        AND EXISTS (
          SELECT 1
            FROM unnest($3::uuid[], $4::bigint[]) AS p(id, epoch)
           WHERE p.id = l.work_item_id
             AND p.epoch = l.lease_epoch
        )`,
    [
      params.resourceKey,
      params.workType,
      params.holders.map((holder) => holder.workItemId),
      params.holders.map((holder) => holder.leaseEpoch),
    ],
  );
}

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

export async function lockPrActorLeaseForUpdate(
  client: PoolClient,
  workItemId: string,
  leaseEpoch: number,
): Promise<void> {
  const row = await queryOne<{ ok: number }>(
    client,
    `SELECT 1 AS ok
       FROM pr_actor_leases
      WHERE work_item_id = $1
        AND lease_epoch = $2
      FOR UPDATE`,
    [workItemId, leaseEpoch],
  );
  if (row != null) return;
  throw new AppError({
    domain: "agent_work",
    kind: "pr_actor_lease_lost",
    message: "PR actor lease is no longer held by this execution",
    context: { workItemId, leaseEpoch },
  });
}

export async function assertPrActorLeaseHeld(
  db: Pool | PoolClient,
  workItemId: string,
  leaseEpoch: number,
): Promise<void> {
  if (await isPrActorLeaseHeld(db, workItemId, leaseEpoch)) return;
  throw new AppError({
    domain: "agent_work",
    kind: "pr_actor_lease_lost",
    message: "PR actor lease is no longer held by this execution",
    context: { workItemId, leaseEpoch },
  });
}

function isPendingWatchdogHop(job: Pick<JobWithMetadata, "state">) {
  return job.state === "created" || job.state === "retry";
}

export async function armLeaseWatchdogHop(
  boss: Pick<PgBoss, "send" | "findJobs" | "getDb">,
  params: {
    readonly queue: string;
    readonly data: { readonly workItemId: string };
    readonly singletonKey: string;
    readonly deferSeconds?: number;
    readonly priority?: number;
    readonly groupId: string;
    readonly workItemId: string;
    readonly onSendFailure: "throw" | "warn-and-proceed";
  },
): Promise<{ readonly liveHop: boolean }> {
  const deferSeconds = params.deferSeconds ?? PR_ACTOR_LEASE_DEFER_SECONDS;
  const sendOptions = {
    singletonKey: params.singletonKey,
    singletonSeconds: deferSeconds,
    singletonNextSlot: true,
    startAfter: deferSeconds,
    ...(params.priority != null ? { priority: params.priority } : {}),
    group: { id: params.groupId },
  };
  const hopId = await boss.send(params.queue, params.data, sendOptions);
  if (hopId != null) return { liveHop: true };
  const hops = await boss.findJobs(params.queue, { key: params.singletonKey });
  let liveHop = hops.some(isPendingWatchdogHop);
  if (liveHop) return { liveHop };
  const terminalIds = hops
    .filter(
      (job) => (job.state === "completed" || job.state === "failed") && job.singletonOn != null,
    )
    .map((job) => job.id);
  if (terminalIds.length > 0) {
    await boss.getDb().executeSql(
      `WITH slots AS (
         SELECT 'epoch'::timestamp + interval '1 second'
                  * ($4::float8 * floor(date_part('epoch', now()) / $4::float8)) AS current_slot
       )
       UPDATE pgboss.job AS j
          SET singleton_on = NULL
         FROM slots
        WHERE j.name = $1
          AND j.singleton_key = $2
          AND j.id = ANY($3::uuid[])
          AND j.state IN ('completed', 'failed')
          AND j.singleton_on IN (
            slots.current_slot,
            slots.current_slot + $4::float8 * interval '1 second'
          )`,
      [params.queue, params.singletonKey, terminalIds, deferSeconds],
    );
    const rearmed = await boss.send(params.queue, params.data, sendOptions);
    if (rearmed != null) return { liveHop: true };
    liveHop = (await boss.findJobs(params.queue, { key: params.singletonKey })).some(
      isPendingWatchdogHop,
    );
  }
  if (!liveHop && params.onSendFailure === "throw") {
    throw new AppError({
      domain: "agent_work",
      kind: "lease_watchdog_arm_failed",
      message: `pg-boss did not enqueue a lease deferral for work item ${params.workItemId}`,
      context: { workItemId: params.workItemId, queue: params.queue },
    });
  }
  return { liveHop };
}
