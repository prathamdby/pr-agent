import type { Pool, PoolClient } from "pg";
import { inTransaction, queryOne } from "../db/postgres.js";
import { logWarn } from "../evlog.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import {
  DESCRIPTION_QUEUE,
  REVIEW_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
} from "../settings/index.js";
import {
  isAnyReviewLens,
  normalizeReviewLens,
  type AnyReviewLens,
} from "../settings/legacyReviewLenses.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkStatus, WorkType } from "./types.js";
import { lockPrActorLeaseForUpdate } from "./prActorLease.js";
import {
  attachWorkItemPayload,
  STALE_HEAD_REPLACEMENT_ID_SQL,
  WorkItemPayloadValidationError,
} from "./workItemPayloadSchema.js";

type AgentWorkRow = {
  id: string;
  webhook_event_id: string | null;
  type: WorkType;
  source: "auto" | "slash";
  status: WorkStatus;
  owner: string;
  repo: string;
  pr_number: number;
  installation_id: string;
  head_sha: string;
  review_lens: AnyReviewLens | "description" | "ask" | "triage" | "verification" | null;
  resource_key: string;
  attempt_count: number;
  payload: unknown;
  cancel_requested_at: Date | null;
};

function workItemRowBase(row: Omit<AgentWorkRow, "payload" | "type" | "source" | "review_lens">) {
  return {
    id: row.id,
    webhookEventId: row.webhook_event_id,
    status: row.status,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    installationId: Number(row.installation_id),
    headSha: row.head_sha,
    resourceKey: row.resource_key,
    attemptCount: row.attempt_count,
    cancelRequestedAt: row.cancel_requested_at,
  };
}

function invalidWorkItemRow(row: Omit<AgentWorkRow, "payload">, detail: string): never {
  throw new WorkItemPayloadValidationError(
    row.type,
    `Invalid ${row.type} work item ${row.id}: ${detail}`,
  );
}

function mapWorkItemCore(row: Omit<AgentWorkRow, "payload">): AgentWorkItemCore {
  const base = workItemRowBase(row);
  switch (row.type) {
    case "review": {
      if (row.review_lens == null) {
        invalidWorkItemRow(row, "missing review_lens");
      }
      if (!isAnyReviewLens(row.review_lens)) {
        invalidWorkItemRow(row, `invalid review_lens "${row.review_lens}"`);
      }
      return {
        ...base,
        type: "review",
        source: row.source,
        reviewLens: normalizeReviewLens(row.review_lens),
      };
    }
    case "ask": {
      if (row.source !== "slash") {
        invalidWorkItemRow(row, `expected source "slash", got "${row.source}"`);
      }
      return {
        ...base,
        type: "ask",
        source: "slash",
        reviewLens: null,
      };
    }
    case "description": {
      return {
        ...base,
        type: "description",
        source: row.source,
        reviewLens: null,
      };
    }
    case "triage": {
      if (row.source !== "slash") {
        invalidWorkItemRow(row, `expected source "slash", got "${row.source}"`);
      }
      return {
        ...base,
        type: "triage",
        source: "slash",
        reviewLens: null,
      };
    }
    case "verification": {
      return {
        ...base,
        type: "verification",
        source: row.source,
        reviewLens: null,
      };
    }
    default: {
      const exhaustive: never = row.type;
      throw new WorkItemPayloadValidationError(
        "review",
        `Unknown work item type: ${String(exhaustive)}`,
      );
    }
  }
}

function mapWorkItem(row: AgentWorkRow): AgentWorkItem {
  return attachWorkItemPayload(mapWorkItemCore(row), row.payload);
}

export async function getWorkItem(
  client: Pool | PoolClient,
  id: string,
): Promise<AgentWorkItem | null> {
  const row = await queryOne<AgentWorkRow>(
    client,
    `SELECT id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id, head_sha,
		        review_lens, resource_key, attempt_count, payload, cancel_requested_at
		   FROM agent_work_items
		  WHERE id = $1`,
    [id],
  );
  return row ? mapWorkItem(row) : null;
}

export async function getWorkItemCore(pool: Pool, id: string): Promise<AgentWorkItemCore | null> {
  const row = await queryOne<Omit<AgentWorkRow, "payload">>(
    pool,
    `SELECT id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id, head_sha,
		        review_lens, resource_key, attempt_count, cancel_requested_at
		   FROM agent_work_items
		  WHERE id = $1`,
    [id],
  );
  return row ? mapWorkItemCore(row) : null;
}

/** Wait-queue rank for the queued progress stub (`#N of M`). */
export type ReviewQueuePosition = {
  readonly position: number;
  readonly total: number;
};

/**
 * Rank of a still-queued review among queued reviews for the same resource key;
 * null when not waiting. `resource_key` is already indexed
 * (`agent_work_items_resource_type_status_idx`).
 */
export async function getReviewQueuePosition(
  pool: Pool,
  workItemId: string,
): Promise<ReviewQueuePosition | null> {
  const row = await queryOne<{ position: number; total: number }>(
    pool,
    `WITH target AS (
       SELECT id, created_at, resource_key
         FROM agent_work_items
        WHERE id = $1
          AND type = 'review'
          AND status = 'queued'
     ),
     queued AS (
       SELECT q.id, q.created_at
         FROM agent_work_items q
         JOIN target t ON q.resource_key = t.resource_key
        WHERE q.type = 'review'
          AND q.status = 'queued'
     )
     SELECT
       (SELECT COUNT(*)::int FROM queued q, target t
         WHERE (q.created_at, q.id) <= (t.created_at, t.id)) AS position,
       (SELECT COUNT(*)::int FROM queued) AS total
     FROM target`,
    [workItemId],
  );
  if (row == null) return null;
  const position = row.position;
  const total = row.total;
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(total) ||
    position < 1 ||
    total < position
  ) {
    return null;
  }
  return { position, total };
}

export async function getWorkItemPayload(pool: Pool, id: string): Promise<unknown> {
  const row = await queryOne<{ payload: unknown }>(
    pool,
    "SELECT payload FROM agent_work_items WHERE id = $1",
    [id],
  );
  return row == null ? undefined : row.payload;
}

function sanitizeWorkError(error: unknown): string {
  return sanitizeLogMessage(error instanceof Error ? error.message : String(error));
}

export type WorkClaim = {
  readonly createdAt: Date;
  readonly startedAt: Date;
  readonly attemptCount: number;
  /** The row was already `running`: a crash, deploy, or lease-hop resume. */
  readonly resumed: boolean;
};

/**
 * Claim queued work or resume a redelivered job while the row is still running.
 * Claims and resumes do not spend the work budget; fresh feature admission does.
 * Admission is owned by the PR actor lease, not the claim: a re-claimed row still
 * needs the lease before any durable write.
 * When `leaseEpoch` is provided (leased work types), the claim also records it
 * on the row as this holder's epoch for intake-cancel release pairs (#660).
 * Unleased callers omit it and leave `execution_epoch` untouched.
 */
export async function claimWorkForExecution(
  db: Pool | PoolClient,
  id: string,
  leaseEpoch?: number | null,
): Promise<WorkClaim | null> {
  const row = await queryOne<{
    created_at: Date;
    started_at: Date;
    attempt_count: number;
    resumed: boolean;
  }>(
    db,
    `WITH prior AS (
       SELECT id, status FROM agent_work_items WHERE id = $1 FOR UPDATE
     )
     UPDATE agent_work_items w
        SET status = 'running',
            started_at = COALESCE(w.started_at, now()),
            execution_epoch = COALESCE($2::bigint, w.execution_epoch),
            updated_at = now()
       FROM prior
      WHERE w.id = prior.id
        AND w.status IN ('queued', 'running')
        AND w.cancel_requested_at IS NULL
    RETURNING w.created_at, w.started_at, w.attempt_count, prior.status = 'running' AS resumed`,
    [id, leaseEpoch ?? null],
  );
  if (!row) return null;
  return {
    createdAt: row.created_at,
    startedAt: row.started_at,
    attemptCount: row.attempt_count,
    resumed: row.resumed,
  };
}

export type WorkAttemptResult =
  | { readonly kind: "started"; readonly claim: Omit<WorkClaim, "resumed"> }
  | { readonly kind: "exhausted"; readonly attemptCount: number }
  | { readonly kind: "unavailable" };

/** Charge fresh work under the same lease-first locking discipline as claim. */
export async function beginWorkAttempt(
  pool: Pool,
  id: string,
  leaseEpoch: number | null,
  attemptLimit: number,
): Promise<WorkAttemptResult> {
  return inTransaction(pool, async (client) => {
    if (leaseEpoch != null) await lockPrActorLeaseForUpdate(client, id, leaseEpoch);
    // A separate statement observes cancellation/takeover committed before the lock.
    const row = await queryOne<{
      status: WorkStatus;
      cancel_requested_at: Date | null;
      attempt_count: number;
      created_at: Date;
      started_at: Date;
    }>(
      client,
      `SELECT status, cancel_requested_at, attempt_count, created_at, started_at
         FROM agent_work_items WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (row == null || row.status !== "running" || row.cancel_requested_at != null) {
      return { kind: "unavailable" };
    }
    if (row.attempt_count >= attemptLimit) {
      return { kind: "exhausted", attemptCount: row.attempt_count };
    }
    await client.query(
      `UPDATE agent_work_items SET attempt_count = attempt_count + 1, updated_at = now()
         WHERE id = $1`,
      [id],
    );
    return {
      kind: "started",
      claim: {
        createdAt: row.created_at,
        startedAt: row.started_at,
        attemptCount: row.attempt_count + 1,
      },
    };
  });
}

/**
 * Lease fence for runner-side durable writes: unfenced when `leaseEpoch` is null
 * (unleased work types), otherwise the write lands only while this holder's epoch
 * still owns the lease row for the work item.
 */
function leaseFenceSql(paramIndex: number): string {
  return `AND ($${paramIndex}::bigint IS NULL OR EXISTS (
	          SELECT 1 FROM pr_actor_leases l
	          WHERE l.work_item_id = agent_work_items.id AND l.lease_epoch = $${paramIndex}))`;
}

export async function markWorkPublishDegraded(
  pool: Pool,
  id: string,
  leaseEpoch: number | null,
): Promise<void> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET payload = payload || '{"publishDegraded": true}'::jsonb,
		        updated_at = now()
		  WHERE id = $1
		    ${leaseFenceSql(2)}`,
    [id, leaseEpoch],
  );
  if ((result.rowCount ?? 0) === 0) {
    logWarn("agent_work_publish_degraded_mark_rejected", {
      workItemId: id,
      leaseEpoch,
      rowCount: result.rowCount,
    });
  }
}

export async function markWorkCompleted(
  pool: Pool,
  id: string,
  leaseEpoch: number | null,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
	    SET status = 'completed',
	        completed_at = now(),
	        updated_at = now()
	  WHERE id = $1
	    AND status = 'running'
	    AND cancel_requested_at IS NULL
	    ${leaseFenceSql(2)}`,
    [id, leaseEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Complete a parent work item that already persisted a stale-head replacement marker. */
export async function forceMarkRescheduledParentCompleted(
  pool: Pool,
  id: string,
  leaseEpoch: number,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'completed',
		        completed_at = COALESCE(completed_at, now()),
		        updated_at = now()
		  WHERE id = $1
		    AND cancel_requested_at IS NULL
		    AND ${STALE_HEAD_REPLACEMENT_ID_SQL} IS NOT NULL
		    AND status IN ('running', 'queued')
		    ${leaseFenceSql(2)}`,
    [id, leaseEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateRunningWorkHeadSha(
  pool: Pool,
  id: string,
  headSha: string,
  leaseEpoch: number | null,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
	    SET head_sha = $2,
	        updated_at = now()
	  WHERE id = $1
	    AND status = 'running'
	    AND cancel_requested_at IS NULL
	    ${leaseFenceSql(3)}`,
    [id, headSha, leaseEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

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

/** A diagnostics snapshot cannot authorize failure after a lease or delivery revives. */
export async function markLostRunningWorkFailed(
  pool: Pool,
  id: string,
  minAgeSeconds: number,
): Promise<boolean> {
  let protectedQuery = false;
  try {
    return await inTransaction(pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL statement_timeout = '1000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '1000ms'");
      const target = await queryOne<{ resource_key: string; type: WorkType }>(
        client,
        `SELECT resource_key, type FROM agent_work_items
          WHERE id = $1
            AND type IN ('review', 'description', 'triage', 'verification')
            AND status = 'running' AND cancel_requested_at IS NULL`,
        [id],
      );
      if (!target) return false;

      protectedQuery = true;
      const leaseSql = `SELECT 1 FROM pr_actor_leases
        WHERE resource_key = $1 AND work_type = $2 FOR UPDATE NOWAIT`;
      const lease = await client.query(leaseSql, [target.resource_key, target.type]);
      if (lease.rows.length === 0) {
        // A missing key has no row to lock against first acquisition.
        await client.query("LOCK TABLE pr_actor_leases IN SHARE MODE NOWAIT");
        await client.query(leaseSql, [target.resource_key, target.type]);
      }
      // Exclude fresh delivery inserts as well as updates, including partitions.
      await client.query("LOCK TABLE pgboss.job IN SHARE MODE NOWAIT");
      await client.query("LOCK TABLE agent_work_items IN ROW EXCLUSIVE MODE NOWAIT");
      const locked = await client.query(
        `SELECT id FROM agent_work_items
          WHERE id = $1 AND resource_key = $2 AND type = $3 FOR UPDATE NOWAIT`,
        [id, target.resource_key, target.type],
      );
      if (locked.rows.length === 0) {
        protectedQuery = false;
        return false;
      }
      // Locks precede this statement so its snapshot includes prior revivals.
      const result = await client.query(
        `UPDATE agent_work_items AS w
            SET status = 'failed',
                last_error = 'worker_lost',
                completed_at = now(),
                updated_at = now()
          WHERE w.id = $1
            AND w.resource_key = $3 AND w.type = $4
            AND w.type IN ('review', 'description', 'triage', 'verification')
            AND w.status = 'running'
            AND w.cancel_requested_at IS NULL
            AND w.started_at IS NOT NULL
            AND w.started_at < statement_timestamp() - ($2 * interval '1 second')
            ${lostRunningWorkLivenessSql("statement_timestamp()")}`,
        [id, minAgeSeconds, target.resource_key, target.type],
      );
      protectedQuery = false;
      return (result.rowCount ?? 0) > 0;
    });
  } catch (error) {
    if (
      protectedQuery &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "55P03" || error.code === "57014")
    ) {
      return false;
    }
    throw error;
  }
}

export async function markWorkFailed(
  pool: Pool,
  id: string,
  error: unknown,
  leaseEpoch?: number | null,
): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const result = await pool.query(
    `UPDATE agent_work_items
	    SET status = 'failed',
	        last_error = $2,
	        completed_at = now(),
	        updated_at = now()
	  WHERE id = $1
	    AND status = 'running'
	    AND cancel_requested_at IS NULL
	    ${leaseFenceSql(3)}`,
    [id, message, leaseEpoch ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Cancel queued work, or its claim winner under the replacement's recorded epoch. */
export async function markQueuedWorkCancelled(
  pool: Pool,
  id: string,
  error: unknown,
): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const cancelSql = `UPDATE agent_work_items
		    SET status = 'cancelled',
		        cancel_requested_at = COALESCE(cancel_requested_at, now()),
		        last_error = $2,
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1`;
  const result = await pool.query(`${cancelSql} AND status = 'queued'`, [id, message]);
  if ((result.rowCount ?? 0) > 0) return true;

  type CancellationTarget = { status: WorkStatus; execution_epoch: string | number | null };
  const targetSql = "SELECT status, execution_epoch FROM agent_work_items WHERE id = $1";
  let target = await queryOne<CancellationTarget>(pool, targetSql, [id]);
  if (!target) return false;
  if (target.status === "cancelled") return true;
  const observedEpoch = Number(target.execution_epoch);
  if (target.status === "queued") {
    // Finish this item-only statement before any lease-first transaction.
    const retry = await pool.query(
      `${cancelSql} AND status = 'queued'
        AND execution_epoch IS NOT DISTINCT FROM $3::bigint`,
      [id, message, target.execution_epoch],
    );
    if ((retry.rowCount ?? 0) > 0) return true;
    target = await queryOne<CancellationTarget>(pool, targetSql, [id]);
    if (!target) return false;
    if (observedEpoch > 0 && Number(target.execution_epoch) !== observedEpoch) return false;
    if (target.status === "cancelled") return true;
  }
  const epoch = observedEpoch > 0 ? observedEpoch : Number(target.execution_epoch);
  if (target.status !== "running" || !Number.isSafeInteger(epoch) || epoch <= 0) return false;
  return inTransaction(pool, async (client) => {
    await lockPrActorLeaseForUpdate(client, id, epoch);
    const cancelled = await client.query(
      `${cancelSql}
        AND status IN ('queued', 'running')
        AND execution_epoch = $3
        ${leaseFenceSql(3)}`,
      [id, message, epoch],
    );
    if ((cancelled.rowCount ?? 0) > 0) return true;
    const current = await queryOne<CancellationTarget>(client, targetSql, [id]);
    return current?.status === "cancelled" && Number(current.execution_epoch) === epoch;
  });
}

export async function markWorkRetrying(
  pool: Pool,
  id: string,
  error: unknown,
  leaseEpoch: number | null,
): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const result = await pool.query(
    `UPDATE agent_work_items
	    SET status = 'queued',
	        last_error = $2,
	        updated_at = now()
	  WHERE id = $1
	    AND status = 'running'
	    AND cancel_requested_at IS NULL
	    ${leaseFenceSql(3)}`,
    [id, message, leaseEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markWorkCancelled(
  pool: Pool,
  id: string,
  leaseEpoch?: number | null,
): Promise<void> {
  await pool.query(
    `UPDATE agent_work_items
	    SET status = 'cancelled',
	        completed_at = now(),
	        updated_at = now()
	  WHERE id = $1
	    AND status IN ('queued', 'running')
	    ${leaseFenceSql(2)}`,
    [id, leaseEpoch ?? null],
  );
}

export async function shouldSkipWork(
  pool: Pool,
  item: Pick<AgentWorkItem, "id">,
): Promise<boolean> {
  const row = await queryOne<{
    status: WorkStatus;
    cancel_requested_at: Date | null;
  }>(pool, "SELECT status, cancel_requested_at FROM agent_work_items WHERE id = $1", [item.id]);
  if (!row) return true;
  return (
    row.status === "superseded" || row.status === "cancelled" || row.cancel_requested_at != null
  );
}
