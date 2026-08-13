import type { IntakeClient } from "../db/postgres.js";
import * as v from "valibot";
import { AppError, nonErrorThrown } from "../errors/appError.js";
import { queryOne } from "../db/postgres.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { jsonValueSchema, type JsonValue } from "../util/jsonValue.js";
import {
  isAnyReviewLens,
  normalizeReviewLens,
  type AnyReviewLens,
} from "../settings/legacyReviewLenses.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkStatus, WorkType } from "./types.js";
import { isWorkItemType } from "./types.js";
import { attachWorkItemPayload, WorkItemPayloadValidationError } from "./workItemPayloadSchema.js";

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
  execution_epoch: string | number;
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
    executionEpoch: Number(row.execution_epoch),
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
  return attachWorkItemPayload(mapWorkItemCore(row), v.parse(jsonValueSchema, row.payload));
}

async function terminalizeInvalidClaimedWorkItem(
  pool: IntakeClient,
  id: string,
  error: Error,
  executionEpoch: number,
): Promise<never> {
  await markWorkFailed(pool, id, error, executionEpoch);
  throw error;
}

export async function getWorkItem(pool: IntakeClient, id: string): Promise<AgentWorkItem | null> {
  const row = await queryOne<AgentWorkRow>(
    pool,
    `SELECT id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id, head_sha,
		        review_lens, resource_key, attempt_count, execution_epoch, payload, cancel_requested_at
		   FROM agent_work_items
		  WHERE id = $1`,
    [id],
  );
  return row ? mapWorkItem(row) : null;
}

export async function getWorkItemCore(
  pool: IntakeClient,
  id: string,
): Promise<AgentWorkItemCore | null> {
  const row = await queryOne<Omit<AgentWorkRow, "payload">>(
    pool,
    `SELECT id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id, head_sha,
		        review_lens, resource_key, attempt_count, execution_epoch, cancel_requested_at
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
  pool: IntakeClient,
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

export async function getWorkItemPayload(
  pool: IntakeClient,
  id: string,
): Promise<JsonValue | undefined> {
  const row = await queryOne<{ payload: JsonValue }>(
    pool,
    "SELECT payload FROM agent_work_items WHERE id = $1",
    [id],
  );
  if (row == null) return undefined;
  return v.parse(jsonValueSchema, row.payload);
}

function sanitizeWorkError(error: Error): string {
  return sanitizeLogMessage(error.message);
}

const CLAIM_QUEUED_WORK_ITEM_RETURNING = `id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id, head_sha,
		        review_lens, resource_key, attempt_count, execution_epoch, payload, cancel_requested_at`;

/** One-query claim: UPDATE queued→running and return the full item; null = not claimable this way. */
export async function claimQueuedWorkItem<T extends WorkType>(
  pool: IntakeClient,
  id: string,
  type: T,
): Promise<Extract<AgentWorkItem, { type: T }> | null> {
  const row = await queryOne<AgentWorkRow>(
    pool,
    `UPDATE agent_work_items
		    SET status = 'running',
		        started_at = COALESCE(started_at, now()),
		        attempt_count = attempt_count + 1,
		        execution_epoch = execution_epoch + 1,
		        updated_at = now()
		  WHERE id = $1
		    AND type = $2
		    AND status = 'queued'
		    AND cancel_requested_at IS NULL
		  RETURNING ${CLAIM_QUEUED_WORK_ITEM_RETURNING}`,
    [id, type],
  );
  if (!row) return null;
  const claimedEpoch = Number(row.execution_epoch);
  try {
    const item = mapWorkItem(row);
    if (!isWorkItemType(item, type)) {
      throw new AppError({
        code: "agent_work.type_mismatch",
        message: `claimed work item ${id} returned type ${item.type}, expected ${type}`,
        context: { workItemId: id, actualType: item.type, expectedType: type },
      });
    }
    return item;
  } catch (error) {
    const err = error instanceof Error ? error : nonErrorThrown("agent_work.non_error_thrown");
    return await terminalizeInvalidClaimedWorkItem(pool, id, err, claimedEpoch);
  }
}

/**
 * Claim queued work or resume a pg-boss retry while the row is still running.
 * Always takes the next execution epoch so a live and a redelivered execution
 * cannot both own the row.
 */
export async function claimWorkForExecution(
  pool: IntakeClient,
  id: string,
): Promise<{ readonly executionEpoch: number } | null> {
  const row = await queryOne<{ execution_epoch: string | number }>(
    pool,
    `UPDATE agent_work_items
		    SET status = 'running',
		        started_at = COALESCE(started_at, now()),
		        attempt_count = CASE
		          WHEN status = 'queued' THEN attempt_count + 1
		          ELSE attempt_count
		        END,
		        execution_epoch = execution_epoch + 1,
		        updated_at = now()
		  WHERE id = $1
		    AND status IN ('queued', 'running')
		    AND cancel_requested_at IS NULL
		  RETURNING execution_epoch`,
    [id],
  );
  return row ? { executionEpoch: Number(row.execution_epoch) } : null;
}

/** True when this claim still owns the row (no newer claim took the epoch). */
export async function isExecutionEpochCurrent(
  pool: IntakeClient,
  id: string,
  executionEpoch: number,
): Promise<boolean> {
  const row = await queryOne<{ execution_epoch: string | number }>(
    pool,
    "SELECT execution_epoch FROM agent_work_items WHERE id = $1",
    [id],
  );
  return row != null && Number(row.execution_epoch) === executionEpoch;
}

/** Reject durable writes/publishes from a superseded claim. */
export async function assertCurrentExecutionEpoch(
  pool: IntakeClient,
  id: string,
  executionEpoch: number,
): Promise<void> {
  if (await isExecutionEpochCurrent(pool, id, executionEpoch)) return;
  throw new AppError({
    code: "agent_work.stale_execution_epoch",
    message: "Work-item execution epoch is no longer current",
    context: { workItemId: id, executionEpoch },
  });
}

export async function markWorkPublishDegraded(pool: IntakeClient, id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_work_items
		    SET payload = payload || '{"publishDegraded": true}'::jsonb,
		        updated_at = now()
		  WHERE id = $1`,
    [id],
  );
}

export async function markWorkCompleted(
  pool: IntakeClient,
  id: string,
  executionEpoch: number,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'completed',
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL
		    AND execution_epoch = $2`,
    [id, executionEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Complete a parent work item that already persisted a stale-head replacement marker. */
export async function forceMarkRescheduledParentCompleted(
  pool: IntakeClient,
  id: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'completed',
		        completed_at = COALESCE(completed_at, now()),
		        updated_at = now()
		  WHERE id = $1
		    AND cancel_requested_at IS NULL
		    AND (payload->>'staleHeadReplacementWorkItemId') IS NOT NULL
		    AND status IN ('running', 'queued')`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateRunningWorkHeadSha(
  pool: IntakeClient,
  id: string,
  headSha: string,
  executionEpoch: number,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET head_sha = $2,
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL
		    AND execution_epoch = $3`,
    [id, headSha, executionEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markWorkFailed(
  pool: IntakeClient,
  id: string,
  error: Error,
  executionEpoch?: number,
): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const result =
    executionEpoch == null
      ? await pool.query(
          `UPDATE agent_work_items
		    SET status = 'failed',
		        last_error = $2,
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL`,
          [id, message],
        )
      : await pool.query(
          `UPDATE agent_work_items
		    SET status = 'failed',
		        last_error = $2,
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL
		    AND execution_epoch = $3`,
          [id, message, executionEpoch],
        );
  return (result.rowCount ?? 0) > 0;
}

/** Cancel a still-queued work item and persist a sanitized failure reason. */
export async function markQueuedWorkCancelled(
  pool: IntakeClient,
  id: string,
  error: Error,
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
  pool: IntakeClient,
  id: string,
  error: Error,
  executionEpoch: number,
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
		    AND execution_epoch = $3`,
    [id, message, executionEpoch],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markWorkCancelled(
  pool: IntakeClient,
  id: string,
  executionEpoch?: number,
): Promise<void> {
  if (executionEpoch == null) {
    await pool.query(
      `UPDATE agent_work_items
		    SET status = 'cancelled',
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status IN ('queued', 'running')`,
      [id],
    );
    return;
  }
  await pool.query(
    `UPDATE agent_work_items
		    SET status = 'cancelled',
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status IN ('queued', 'running')
		    AND execution_epoch = $2`,
    [id, executionEpoch],
  );
}

export async function shouldSkipWork(
  pool: IntakeClient,
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

export async function hasActiveReviewWorkItem(
  pool: IntakeClient,
  resourceKey: string,
): Promise<boolean> {
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
