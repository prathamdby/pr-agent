import type { PoolClient } from "pg";

export type AutoWorkSupersedeTarget =
  | {
      readonly kind: "review";
      readonly resourceKey: string;
    }
  | { readonly kind: "description"; readonly resourceKey: string }
  | { readonly kind: "triage"; readonly resourceKey: string }
  | { readonly kind: "verification"; readonly resourceKey: string };

function autoWorkIntakeLockKey(target: AutoWorkSupersedeTarget): string {
  return JSON.stringify(["auto_work_intake", target.kind, target.resourceKey]);
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

function supersedeQueuedSql(target: AutoWorkSupersedeTarget): {
  sql: string;
  params: unknown[];
} {
  if (target.kind === "review") {
    return {
      sql: `UPDATE agent_work_items
			       SET status = 'superseded', updated_at = now()
			     WHERE resource_key = $1
			       AND review_lens = $2
			       AND source = 'auto'
			       AND status = 'queued'
			     RETURNING id`,
      params: [target.resourceKey, "review"],
    };
  }
  return {
    sql: `UPDATE agent_work_items
			     SET status = 'superseded', updated_at = now()
			   WHERE resource_key = $1
			     AND type = $2
			     AND source = 'auto'
			     AND status = 'queued'
			   RETURNING id`,
    params: [target.resourceKey, target.kind],
  };
}

function cancelRunningSql(target: AutoWorkSupersedeTarget): {
  sql: string;
  params: unknown[];
} {
  if (target.kind === "review") {
    return {
      sql: `UPDATE agent_work_items
			       SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
			     WHERE resource_key = $1
			       AND review_lens = $2
			       AND source = 'auto'
			       AND status = 'running'
			     RETURNING id`,
      params: [target.resourceKey, "review"],
    };
  }
  return {
    sql: `UPDATE agent_work_items
			     SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
			   WHERE resource_key = $1
			     AND type = $2
			     AND source = 'auto'
			     AND status = 'running'
			   RETURNING id`,
    params: [target.resourceKey, target.kind],
  };
}

/**
 * Supersede queued auto work and request cancel on running rows under the intake
 * lock. Returns the affected ids; an empty list means no active auto work.
 */
async function supersedeActiveAutoWork(
  client: PoolClient,
  target: AutoWorkSupersedeTarget,
): Promise<readonly string[]> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    autoWorkIntakeLockKey(target),
  ]);
  const queuedQuery = supersedeQueuedSql(target);
  const runningQuery = cancelRunningSql(target);
  const queued = await client.query<{ id: string }>(queuedQuery.sql, queuedQuery.params);
  const running = await client.query<{ id: string }>(runningQuery.sql, runningQuery.params);
  return [...queued.rows, ...running.rows].map((r) => r.id);
}

/** Supersede queued auto work, request cancel on running, create replacement, link superseded rows. */
export async function replaceAutoWorkItem(params: {
  readonly client: PoolClient;
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
}): Promise<{
  readonly workItemId: string;
  readonly supersededIds: readonly string[];
}> {
  const supersededIds = await supersedeActiveAutoWork(params.client, params.target);
  const workItemId = await params.createWorkItem();
  if (supersededIds.length > 0) {
    await linkSupersededWorkItems(params.client, workItemId, supersededIds);
  }
  return { workItemId, supersededIds };
}

/**
 * Like replaceAutoWorkItem, but the replacement is created only when active auto
 * work exists. A push must not start a review on a PR whose review already
 * finished; it only redirects work that is still queued or running.
 */
export async function replaceActiveAutoWorkItem(params: {
  readonly client: PoolClient;
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
}): Promise<{
  readonly workItemId: string | null;
  readonly supersededIds: readonly string[];
}> {
  const supersededIds = await supersedeActiveAutoWork(params.client, params.target);
  if (supersededIds.length === 0) {
    return { workItemId: null, supersededIds };
  }
  const workItemId = await params.createWorkItem();
  await linkSupersededWorkItems(params.client, workItemId, supersededIds);
  return { workItemId, supersededIds };
}
