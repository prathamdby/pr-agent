import type { PoolClient } from "pg";
import type { WorkSource } from "../review/reviewSchema.ts";
import { releasePrActorLeaseHeldByWorkItems } from "./prActorLease.ts";
import { transition, type TransitionSelector } from "./workItemTransitions.ts";
import { unleasedFence } from "./writeFence.ts";

export type AutoWorkSupersedeTarget =
  | {
      readonly kind: "review";
      readonly resourceKey: string;
    }
  | { readonly kind: "description"; readonly resourceKey: string }
  | { readonly kind: "triage"; readonly resourceKey: string }
  | { readonly kind: "verification"; readonly resourceKey: string };

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

function autoWorkIntakeLockKey(target: AutoWorkSupersedeTarget): string {
  return JSON.stringify(["auto_work_intake", target.kind, target.resourceKey]);
}

export async function acquireAutoWorkIntakeLock(
  client: PoolClient,
  target: AutoWorkSupersedeTarget,
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

function supersedeSelector(target: AutoWorkSupersedeTarget): TransitionSelector {
  return target.kind === "review"
    ? { resourceKey: target.resourceKey, reviewLens: "review", source: "auto" }
    : { resourceKey: target.resourceKey, type: target.kind, source: "auto" };
}

function supersededLifecycle(
  target: AutoWorkSupersedeTarget,
  row: {
    readonly id: string;
    readonly head_sha: string;
    readonly source: WorkSource;
  },
): AutoWorkLifecycleChange {
  return {
    id: row.id,
    headSha: row.head_sha,
    source: row.source,
    workType: target.kind,
    lifecycleStatus: "superseded",
  };
}

export async function supersedeActiveAutoWork(
  client: PoolClient,
  target: AutoWorkSupersedeTarget,
  options?: { readonly preserveQueuedIds?: readonly string[] },
): Promise<AutoWorkSupersedeResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    autoWorkIntakeLockKey(target),
  ]);
  const preserveQueuedIds = options?.preserveQueuedIds ?? [];
  const selector = supersedeSelector(target);
  const queued = await transition(client, {
    selector,
    from: ["queued"],
    to: "superseded",
    returning: ["id", "execution_epoch", "head_sha", "source"],
    fence: unleasedFence(),
    ...(preserveQueuedIds.length === 0
      ? {}
      : {
          where: (bind) => `AND w.id <> ALL(${bind(preserveQueuedIds)}::uuid[])`,
        }),
  });
  const running = await transition(client, {
    selector,
    from: ["running"],
    to: "superseded",
    requestCancel: true,
    returning: ["id", "execution_epoch", "head_sha", "source"],
    fence: unleasedFence(),
  });
  const rows = [...queued.rows, ...running.rows];
  const holders = rows
    .map((row) => ({ workItemId: row.id, leaseEpoch: Number(row.execution_epoch ?? 0) }))
    .filter((holder) => holder.leaseEpoch > 0);
  await releasePrActorLeaseHeldByWorkItems(client, {
    resourceKey: target.resourceKey,
    workType: target.kind,
    holders,
  });
  return {
    supersededIds: rows.map((row) => row.id),
    lifecycleChanges: rows.map((row) => supersededLifecycle(target, row)),
  };
}

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

export async function replaceActiveAutoWorkItem(params: {
  readonly client: PoolClient;
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
}): Promise<{
  readonly workItemId: string | null;
  readonly supersededIds: readonly string[];
  readonly lifecycleChanges: readonly AutoWorkLifecycleChange[];
}> {
  const { supersededIds, lifecycleChanges } = await supersedeActiveAutoWork(
    params.client,
    params.target,
  );
  if (supersededIds.length === 0) {
    return { workItemId: null, supersededIds, lifecycleChanges };
  }
  const workItemId = await params.createWorkItem();
  await linkSupersededWorkItems(params.client, workItemId, supersededIds);
  return { workItemId, supersededIds, lifecycleChanges };
}
