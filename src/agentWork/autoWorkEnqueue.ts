import type { IntakeClient } from "../db/postgres.js";

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

type AutoWorkSql = {
  readonly sql: string;
  readonly params: readonly string[];
};

function supersedeQueuedSql(target: AutoWorkSupersedeTarget): AutoWorkSql {
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

function cancelRunningSql(target: AutoWorkSupersedeTarget): AutoWorkSql {
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

/** Supersede queued auto work, request cancel on running, create replacement, link superseded rows. */
export async function replaceAutoWorkItem(params: {
  readonly client: IntakeClient;
  readonly target: AutoWorkSupersedeTarget;
  readonly createWorkItem: () => Promise<string>;
}): Promise<{
  readonly workItemId: string;
  readonly supersededIds: readonly string[];
}> {
  await params.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    autoWorkIntakeLockKey(params.target),
  ]);
  const queuedQuery = supersedeQueuedSql(params.target);
  const runningQuery = cancelRunningSql(params.target);
  const queued = await params.client.query<{ id: string }>(queuedQuery.sql, [
    ...queuedQuery.params,
  ]);
  const running = await params.client.query<{ id: string }>(runningQuery.sql, [
    ...runningQuery.params,
  ]);
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
