import type { PoolClient } from "pg";
import type { WorkSource } from "../review/reviewSchema.js";
import { releasePrActorLeaseHeldByWorkItems } from "./prActorLease.js";
import { transition, type TransitionSelector } from "./workItemTransitions.js";
import { unleasedFence } from "./writeFence.js";

export type AutoWorkIntakeLockTarget =
  | { readonly kind: "review"; readonly resourceKey: string }
  | { readonly kind: "description"; readonly resourceKey: string }
  | { readonly kind: "triage"; readonly resourceKey: string }
  | { readonly kind: "verification"; readonly resourceKey: string };

export type AutoWorkSupersedeTarget =
  | {
      readonly kind: "review";
      readonly resourceKey: string;
      /**
       * `push` replaces every in-progress review, including slash.
       * `automatic` replaces only automatic rows, so an open or approval
       * admission leaves a slash review that already won the intake lock.
       */
      readonly scope: "push" | "automatic";
    }
  | Exclude<AutoWorkIntakeLockTarget, { readonly kind: "review" }>;

export type AutoWorkLifecycleChange = {
  readonly id: string;
  readonly headSha: string;
  readonly source: WorkSource;
  readonly workType: AutoWorkSupersedeTarget["kind"];
  readonly lifecycleStatus: "superseded" | "cancel_requested";
};

type AutoWorkSupersedeResult = {
  readonly supersededIds: readonly string[];
  readonly lifecycleChanges: readonly AutoWorkLifecycleChange[];
};

function autoWorkIntakeLockKey(target: AutoWorkIntakeLockTarget): string {
  return JSON.stringify(["auto_work_intake", target.kind, target.resourceKey]);
}

/**
 * Serializes automated intake and slash reviews through commit or rollback.
 * Review callers acquire it before cancellation or insertion so a force sees
 * the preceding transaction's replacement, including ordinary slash inserts.
 */
export async function acquireAutoWorkIntakeLock(
  client: PoolClient,
  target: AutoWorkIntakeLockTarget,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    autoWorkIntakeLockKey(target),
  ]);
}

function linkSupersededWorkItems(
  client: PoolClient,
  workItemId: string,
  supersededIds: readonly string[],
): Promise<unknown> {
  return client.query(`UPDATE agent_work_items SET superseded_by = $1 WHERE id = ANY($2::uuid[])`, [
    workItemId,
    supersededIds,
  ]);
}

function reviewReplacesEverySource(target: AutoWorkSupersedeTarget): boolean {
  return target.kind === "review" && target.scope === "push";
}

function supersedeSelector(target: AutoWorkSupersedeTarget): TransitionSelector {
  // A push replaces every in-progress review. Open, approval admission,
  // description, and verification stay on automatic rows.
  return reviewReplacesEverySource(target)
    ? { resourceKey: target.resourceKey, type: "review" }
    : { resourceKey: target.resourceKey, type: target.kind, source: "auto" };
}

function cancelRunningSql(target: AutoWorkSupersedeTarget): {
  sql: string;
  params: unknown[];
} {
  const sourcePredicate = reviewReplacesEverySource(target) ? "" : "AND source = 'auto'";
  return {
    // Lock and retain the prior request bit so relinking an already-cancelled
    // running row preserves replacement behavior without reporting a new request.
    sql: `WITH prior AS MATERIALIZED (
            SELECT id, cancel_requested_at
              FROM agent_work_items
             WHERE resource_key = $1
               AND type = $2
               ${sourcePredicate}
               AND status = 'running'
             FOR UPDATE
          )
          UPDATE agent_work_items w
             SET cancel_requested_at = COALESCE(w.cancel_requested_at, now()), updated_at = now()
            FROM prior
           WHERE w.id = prior.id AND w.status = 'running'
          RETURNING w.id, w.execution_epoch, w.head_sha, w.source,
                    (prior.cancel_requested_at IS NULL) AS cancel_changed`,
    params: [target.resourceKey, target.kind],
  };
}

/**
 * Supersede queued work and request cancel on running rows under the intake
 * lock. Push-scoped review covers auto and slash. Automatic review and other
 * kinds stay on automatic rows.
 * Running rows stay `running` with `cancel_requested_at` set while they wind
 * down; both sets release their PR actor lease holders in the same transaction so
 * the replacement acquires immediately instead of hop-looping till TTL.
 * Returns the affected ids; an empty list means nothing queued or running.
 */
async function supersedeActiveAutoWork(
  client: PoolClient,
  target: AutoWorkSupersedeTarget,
): Promise<AutoWorkSupersedeResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    autoWorkIntakeLockKey(target),
  ]);
  const runningQuery = cancelRunningSql(target);
  const queued = await transition(client, {
    selector: supersedeSelector(target),
    from: ["queued"],
    to: "superseded",
    returning: ["id", "execution_epoch", "head_sha", "source"],
    fence: unleasedFence(),
  });
  const running = await client.query<{
    id: string;
    execution_epoch: string | number | null;
    head_sha: string;
    source: WorkSource;
    cancel_changed: boolean;
  }>(runningQuery.sql, runningQuery.params);
  const holders = [...queued.rows, ...running.rows]
    .map((row) => ({ workItemId: row.id, leaseEpoch: Number(row.execution_epoch ?? 0) }))
    .filter((holder) => holder.leaseEpoch > 0);
  // Target kind is the lease work type. Triage is slash-only and this selector
  // keeps description and verification on automatic rows, so those match nothing.
  await releasePrActorLeaseHeldByWorkItems(client, {
    resourceKey: target.resourceKey,
    workType: target.kind,
    holders,
  });
  return {
    supersededIds: [...queued.rows, ...running.rows].map((r) => r.id),
    lifecycleChanges: [
      ...queued.rows.map((row) => ({
        id: row.id,
        headSha: row.head_sha,
        source: row.source,
        workType: target.kind,
        lifecycleStatus: "superseded" as const,
      })),
      ...running.rows
        .filter((row) => row.cancel_changed)
        .map((row) => ({
          id: row.id,
          headSha: row.head_sha,
          source: row.source,
          workType: target.kind,
          lifecycleStatus: "cancel_requested" as const,
        })),
    ],
  };
}

/** Supersede queued auto work, request cancel on running, create replacement, link superseded rows. */
export async function replaceAutoWorkItem(params: {
  readonly client: PoolClient;
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
}): Promise<{
  readonly workItemId: string;
  readonly supersededIds: readonly string[];
  readonly lifecycleChanges: readonly AutoWorkLifecycleChange[];
}> {
  const { supersededIds, lifecycleChanges } = await supersedeActiveAutoWork(
    params.client,
    params.target,
  );
  const workItemId = await params.createWorkItem();
  if (supersededIds.length > 0) {
    await linkSupersededWorkItems(params.client, workItemId, supersededIds);
  }
  return { workItemId, supersededIds, lifecycleChanges };
}
