import type { Pool } from "pg";
import { queryOne } from "../db/postgres.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import {
  isAnyReviewLens,
  normalizeReviewLens,
  type AnyReviewLens,
} from "../settings/legacyReviewLenses.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkStatus, WorkType } from "./types.js";
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
      if (row.source !== "auto") {
        invalidWorkItemRow(row, `expected source "auto", got "${row.source}"`);
      }
      return {
        ...base,
        type: "verification",
        source: "auto",
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

export async function getWorkItem(pool: Pool, id: string): Promise<AgentWorkItem | null> {
  const row = await queryOne<AgentWorkRow>(
    pool,
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

/** Wait-queue rank for the queued progress stub (`#2 of 10`). */
export type ReviewQueuePosition = {
  readonly position: number;
  readonly total: number;
};

/**
 * Rank of a still-queued review work item among all queued reviews; null when not waiting.
 * Scan cost is O(queued work items of every type) under the (status) index until a
 * `(type, status, created_at)` covering index lands; no migration in this change.
 */
export async function getReviewQueuePosition(
  pool: Pool,
  workItemId: string,
): Promise<ReviewQueuePosition | null> {
  const row = await queryOne<{ position: number; total: number }>(
    pool,
    `WITH target AS (
       SELECT id, created_at
         FROM agent_work_items
        WHERE id = $1
          AND type = 'review'
          AND status = 'queued'
     ),
     queued AS (
       SELECT id, created_at
         FROM agent_work_items
        WHERE type = 'review'
          AND status = 'queued'
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
};

/**
 * Claim queued work or resume a redelivered job while the row is still running.
 * Admission is owned by the PR actor lease, not the claim: a re-claimed row still
 * needs the lease before any durable write.
 */
export async function claimWorkForExecution(pool: Pool, id: string): Promise<WorkClaim | null> {
  const row = await queryOne<{
    created_at: Date;
    started_at: Date;
    attempt_count: number;
  }>(
    pool,
    `UPDATE agent_work_items
	    SET status = 'running',
	        started_at = COALESCE(started_at, now()),
        attempt_count = CASE
          WHEN status = 'queued' THEN attempt_count + 1
          ELSE attempt_count
        END,
        updated_at = now()
	  WHERE id = $1
	    AND status IN ('queued', 'running')
	    AND cancel_requested_at IS NULL
    RETURNING created_at, started_at, attempt_count`,
    [id],
  );
  if (!row) return null;
  return {
    createdAt: row.created_at,
    startedAt: row.started_at,
    attemptCount: row.attempt_count,
  };
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
  await pool.query(
    `UPDATE agent_work_items
		    SET payload = payload || '{"publishDegraded": true}'::jsonb,
		        updated_at = now()
		  WHERE id = $1
		    ${leaseFenceSql(2)}`,
    [id, leaseEpoch],
  );
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
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'completed',
		        completed_at = COALESCE(completed_at, now()),
		        updated_at = now()
		  WHERE id = $1
		    AND cancel_requested_at IS NULL
		    AND ${STALE_HEAD_REPLACEMENT_ID_SQL} IS NOT NULL
		    AND status IN ('running', 'queued')`,
    [id],
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

/** Cancel a still-queued work item and persist a sanitized failure reason. */
export async function markQueuedWorkCancelled(
  pool: Pool,
  id: string,
  error: unknown,
): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'cancelled',
		        last_error = $2,
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'queued'`,
    [id, message],
  );
  return (result.rowCount ?? 0) > 0;
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

export async function hasActiveReviewWorkItem(pool: Pool, resourceKey: string): Promise<boolean> {
  const row = await queryOne<{ active: boolean }>(
    pool,
    `SELECT EXISTS (
       SELECT 1
         FROM agent_work_items
        WHERE resource_key = $1
          AND type = 'review'
          AND status IN ('queued', 'running')
     ) AS active`,
    [resourceKey],
  );
  return row?.active ?? false;
}
