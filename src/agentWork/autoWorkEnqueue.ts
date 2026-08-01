import type { PoolClient } from "pg";

export type AutoWorkSupersedeTarget =
  | {
      readonly kind: "review";
      readonly resourceKey: string;
    }
  | { readonly kind: "description"; readonly resourceKey: string }
  | { readonly kind: "triage"; readonly resourceKey: string }
  | { readonly kind: "verification"; readonly resourceKey: string };

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
 * Cancel active orchestrated reviews for a PR (auto + slash).
 * Queued → terminal cancelled; running → cooperative cancel_requested_at.
 */
export async function cancelActiveReviewsForResource(
  client: PoolClient,
  resourceKey: string,
): Promise<readonly string[]> {
  const queued = await client.query<{ id: string }>(
    `UPDATE agent_work_items
         SET status = 'cancelled',
             last_error = $2,
             completed_at = now(),
             updated_at = now()
       WHERE resource_key = $1
         AND type = 'review'
         AND status = 'queued'
     RETURNING id`,
    [resourceKey, "Pull request merged"],
  );
  const running = await client.query<{ id: string }>(
    `UPDATE agent_work_items
         SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
             updated_at = now()
       WHERE resource_key = $1
         AND type = 'review'
         AND status = 'running'
     RETURNING id`,
    [resourceKey],
  );
  return [...queued.rows, ...running.rows].map((row) => row.id);
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
