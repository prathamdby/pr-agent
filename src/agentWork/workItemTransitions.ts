import type { Pool, PoolClient } from "pg";
import type { WorkSource } from "../review/reviewSchema.js";
import {
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.js";
import type { WorkStatus, WorkType } from "./types.js";

/** Shared lost-running predicate; queued diagnostics deliberately use resource-wide leases. */
export function lostRunningWorkLivenessSql(
  clock: "$1::timestamptz" | "statement_timestamp()",
): string {
  return `AND NOT EXISTS (
            SELECT 1 FROM pr_actor_leases l
             WHERE l.work_item_id = w.id
               AND l.expires_at > ${clock}
          )
          AND NOT EXISTS (
            SELECT 1 FROM pgboss.job j
             WHERE j.name = CASE w.type
               WHEN 'review' THEN '${REVIEW_QUEUE}'
               WHEN 'description' THEN '${DESCRIPTION_QUEUE}'
               WHEN 'triage' THEN '${TRIAGE_QUEUE}'
               WHEN 'verification' THEN '${VERIFICATION_QUEUE}'
             END
               AND j.state IN ('created', 'active', 'retry')
               AND (
                 j.id = w.id
                 OR j.singleton_key = w.id::text
                 OR j.data @> jsonb_build_object('workItemId', w.id::text)
               )
          )`;
}

/**
 * Lease fence for runner-side durable writes: unfenced when the epoch parameter
 * is null (unleased work types), otherwise the write lands only while this
 * holder's epoch still owns the lease row for the work item.
 */
export function leaseFenceSql(workItemIdColumn: string, epochParam: string): string {
  return `AND (${epochParam}::bigint IS NULL OR EXISTS (
	          SELECT 1 FROM pr_actor_leases l
	          WHERE l.work_item_id = ${workItemIdColumn} AND l.lease_epoch = ${epochParam}))`;
}

type TransitionRow = {
  readonly id: string;
  readonly source: WorkSource;
  readonly head_sha: string;
  readonly created_at: Date;
  readonly started_at: Date;
  readonly attempt_count: number;
  readonly payload: unknown;
  readonly execution_epoch: string | number | null;
  /** Status the row held before the transition; needs `lockPrior`. */
  readonly prior_status: WorkStatus;
};

export type TransitionColumn = keyof TransitionRow;

/** Each key present becomes one equality predicate; absent keys do not constrain. */
export type TransitionSelector = {
  readonly id?: string;
  readonly resourceKey?: string;
  readonly type?: WorkType;
  readonly reviewLens?: string;
  readonly source?: WorkSource;
};

export type TransitionSpec<K extends TransitionColumn> = {
  readonly selector: TransitionSelector;
  /** The write lands only while the row still holds one of these statuses. */
  readonly from: readonly WorkStatus[];
  readonly to: WorkStatus;
  /** A recorded cancel request wins over every transition that carries this. */
  readonly unlessCancelRequested?: boolean;
  /**
   * A numeric epoch lands the write only while that holder owns the lease row;
   * null or omitted is an unleased writer.
   */
  readonly leaseEpoch?: number | null;
  /** Extra predicates, each led by `AND`. Bind values through the callback. */
  readonly where?: (bind: (value: unknown) => string) => string;
  readonly lastError?: string;
  readonly requestCancel?: boolean;
  readonly payloadPatch?: string;
  /** `null` keeps the recorded epoch, matching an unleased claim. */
  readonly executionEpoch?: number | null;
  /** Terminal targets stamp `completed_at`; this keeps an earlier stamp. */
  readonly keepCompletedAt?: boolean;
  /** Reads this row `FOR UPDATE` first so `prior_status` is available; the selector omits `id`. */
  readonly lockPrior?: { readonly id: string };
  readonly returning?: readonly K[];
};

export type TransitionResult<K extends TransitionColumn> = {
  readonly rowCount: number;
  readonly rows: readonly Pick<TransitionRow, K>[];
};

const SELECTOR_COLUMNS: readonly (readonly [keyof TransitionSelector, string])[] = [
  ["id", "id"],
  ["resourceKey", "resource_key"],
  ["type", "type"],
  ["reviewLens", "review_lens"],
  ["source", "source"],
];

const TARGET_STAMP: Record<WorkStatus, "started" | "completed" | "none"> = {
  queued: "none",
  running: "started",
  superseded: "none",
  cancelled: "completed",
  completed: "completed",
  failed: "completed",
};

function statusLiteral(status: WorkStatus): string {
  return `'${status}'`;
}

function statusPredicate(from: readonly WorkStatus[]): string {
  const [only, ...rest] = from;
  if (only != null && rest.length === 0) return `w.status = ${statusLiteral(only)}`;
  return `w.status IN (${from.map(statusLiteral).join(", ")})`;
}

/**
 * The only writer of `agent_work_items.status`. Every caller states the
 * statuses it may leave, and the guard that decides a race (cancel request,
 * lease epoch, extra predicate) travels in the same statement, so a lost race
 * changes no row and reports `rowCount` 0. Initial `queued` inserts stay with
 * intake; they create rows rather than move them.
 */
export async function transition<K extends TransitionColumn = never>(
  db: Pool | PoolClient,
  spec: TransitionSpec<K>,
): Promise<TransitionResult<K>> {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const assignments = [`status = ${statusLiteral(spec.to)}`];
  const stamp = TARGET_STAMP[spec.to];
  if (stamp === "started") assignments.push("started_at = COALESCE(w.started_at, now())");
  if (spec.executionEpoch !== undefined) {
    assignments.push(
      `execution_epoch = COALESCE(${bind(spec.executionEpoch)}::bigint, w.execution_epoch)`,
    );
  }
  if (spec.requestCancel) {
    assignments.push("cancel_requested_at = COALESCE(w.cancel_requested_at, now())");
  }
  if (spec.lastError !== undefined) assignments.push(`last_error = ${bind(spec.lastError)}`);
  if (stamp === "completed") {
    assignments.push(
      spec.keepCompletedAt
        ? "completed_at = COALESCE(w.completed_at, now())"
        : "completed_at = now()",
    );
  }
  if (spec.payloadPatch !== undefined) {
    assignments.push(
      `payload = COALESCE(w.payload, '{}'::jsonb) || ${bind(spec.payloadPatch)}::jsonb`,
    );
  }
  assignments.push("updated_at = now()");

  let prior = "";
  let from = "";
  const predicates: string[] = [];
  if (spec.lockPrior) {
    prior = `WITH prior AS (
       SELECT id, status FROM agent_work_items WHERE id = ${bind(spec.lockPrior.id)} FOR UPDATE
     )
     `;
    from = "FROM prior";
    predicates.push("w.id = prior.id");
  }
  for (const [key, column] of SELECTOR_COLUMNS) {
    const value = spec.selector[key];
    if (value !== undefined) predicates.push(`w.${column} = ${bind(value)}`);
  }
  predicates.push(statusPredicate(spec.from));
  if (spec.unlessCancelRequested) predicates.push("w.cancel_requested_at IS NULL");
  const extra = [
    spec.where?.(bind),
    typeof spec.leaseEpoch === "number" ? leaseFenceSql("w.id", bind(spec.leaseEpoch)) : undefined,
  ].filter((fragment) => fragment !== undefined);

  const returning = (spec.returning ?? []).map((column) =>
    column === "prior_status" ? "prior.status AS prior_status" : `w.${column}`,
  );
  const result = await db.query<Pick<TransitionRow, K>>(
    `${prior}UPDATE agent_work_items AS w
        SET ${assignments.join(",\n            ")}
       ${from}
      WHERE ${predicates.join("\n        AND ")}
        ${extra.join("\n        ")}${returning.length > 0 ? `\n    RETURNING ${returning.join(", ")}` : ""}`,
    params,
  );
  return { rowCount: result.rowCount ?? 0, rows: result.rows };
}
