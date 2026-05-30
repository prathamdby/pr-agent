import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { ReviewMode } from "../review/reviewSchema.js";
import type { SingletonSlotDb } from "./singletonQueue.js";

export type AutoWorkSupersedeTarget =
  | { readonly kind: "review"; readonly resourceKey: string; readonly lens: ReviewMode }
  | { readonly kind: "description"; readonly resourceKey: string };

function supersedeQueuedSql(target: AutoWorkSupersedeTarget): { sql: string; params: unknown[] } {
  if (target.kind === "review") {
    return {
      sql: `UPDATE agent_work_items
			       SET status = 'superseded', updated_at = now()
			     WHERE resource_key = $1
			       AND review_lens = $2
			       AND source = 'auto'
			       AND status = 'queued'
			     RETURNING id`,
      params: [target.resourceKey, target.lens],
    };
  }
  return {
    sql: `UPDATE agent_work_items
			     SET status = 'superseded', updated_at = now()
			   WHERE resource_key = $1
			     AND type = 'description'
			     AND source = 'auto'
			     AND status = 'queued'
			   RETURNING id`,
    params: [target.resourceKey],
  };
}

function cancelRunningSql(target: AutoWorkSupersedeTarget): { sql: string; params: unknown[] } {
  if (target.kind === "review") {
    return {
      sql: `UPDATE agent_work_items
			       SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
			     WHERE resource_key = $1
			       AND review_lens = $2
			       AND source = 'auto'
			       AND status = 'running'
			     RETURNING id`,
      params: [target.resourceKey, target.lens],
    };
  }
  return {
    sql: `UPDATE agent_work_items
			     SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
			   WHERE resource_key = $1
			     AND type = 'description'
			     AND source = 'auto'
			     AND status = 'running'
			   RETURNING id`,
    params: [target.resourceKey],
  };
}

/** Supersede queued auto work, request cancel on running, create replacement, link superseded rows. */
export async function replaceAutoWorkItem(params: {
  readonly client: PoolClient;
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
}): Promise<{ readonly workItemId: string; readonly supersededIds: readonly string[] }> {
  const queuedQuery = supersedeQueuedSql(params.target);
  const runningQuery = cancelRunningSql(params.target);
  const queued = await params.client.query<{ id: string }>(queuedQuery.sql, queuedQuery.params);
  const running = await params.client.query<{ id: string }>(runningQuery.sql, runningQuery.params);
  const supersededIds = [...queued.rows, ...running.rows].map((r) => r.id);
  const workItemId = await params.createWorkItem();
  if (supersededIds.length > 0) {
    await params.client.query(
      `UPDATE agent_work_items SET superseded_by = $1 WHERE id = ANY($2::uuid[])`,
      [workItemId, supersededIds],
    );
  }
  return { workItemId, supersededIds };
}

export async function releaseSingletonIfSuperseded(params: {
  readonly boss: PgBoss;
  readonly db: SingletonSlotDb;
  readonly supersededIds: readonly string[];
  readonly release: () => Promise<void>;
}): Promise<void> {
  if (params.supersededIds.length === 0) return;
  await params.release();
}
