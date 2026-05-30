import crypto from "node:crypto";
import type { Pool } from "pg";
import { queryOne } from "../db/postgres.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { parseStoredInlineFingerprints } from "../agent/reviewFindingFingerprint.js";
import { DESCRIPTION_PUBLISH_LENS } from "../settings/index.js";
import type { AgentWorkItem, ReviewWorkPayload, WorkStatus } from "./types.js";

export type PublishLens = ReviewWorkPayload["mode"] | typeof DESCRIPTION_PUBLISH_LENS;
export type PublishStep =
  | "progress_comment"
  | "inline_review"
  | "summary_comment"
  | "labels"
  | "pr_body";

type AgentWorkRow = {
  id: string;
  webhook_event_id: string | null;
  type: "review" | "ask" | "description";
  source: "auto" | "slash";
  status: WorkStatus;
  owner: string;
  repo: string;
  pr_number: number;
  installation_id: string;
  head_sha: string;
  review_lens: "review" | "review-security" | "review-quality" | null;
  resource_key: string;
  attempt_count: number;
  payload: AgentWorkItem["payload"];
  cancel_requested_at: Date | null;
};

function mapWorkItem(row: AgentWorkRow): AgentWorkItem {
  return {
    id: row.id,
    webhookEventId: row.webhook_event_id,
    type: row.type,
    source: row.source,
    status: row.status,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    installationId: Number(row.installation_id),
    headSha: row.head_sha,
    reviewLens: row.review_lens,
    resourceKey: row.resource_key,
    attemptCount: row.attempt_count,
    payload: row.payload,
    cancelRequestedAt: row.cancel_requested_at,
  };
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

function sanitizeWorkError(error: unknown): string {
  return sanitizeLogMessage(error instanceof Error ? error.message : String(error));
}

export async function markWorkRunning(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'running',
		        started_at = COALESCE(started_at, now()),
		        attempt_count = attempt_count + 1,
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'queued'
		    AND cancel_requested_at IS NULL`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Claim queued work or resume a pg-boss retry while the row is still running. */
export async function claimWorkForExecution(pool: Pool, id: string): Promise<boolean> {
  if (await markWorkRunning(pool, id)) return true;
  const row = await queryOne<{ status: WorkStatus; cancel_requested_at: Date | null }>(
    pool,
    "SELECT status, cancel_requested_at FROM agent_work_items WHERE id = $1",
    [id],
  );
  return row?.status === "running" && row.cancel_requested_at == null;
}

export async function markWorkPublishDegraded(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_work_items
		    SET payload = payload || '{"publishDegraded": true}'::jsonb,
		        updated_at = now()
		  WHERE id = $1`,
    [id],
  );
}

export async function markWorkCompleted(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'completed',
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL`,
    [id],
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
		    AND (payload->>'staleHeadReplacementWorkItemId') IS NOT NULL
		    AND status IN ('running', 'queued')`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateRunningWorkHeadSha(
  pool: Pool,
  id: string,
  headSha: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET head_sha = $2,
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL`,
    [id, headSha],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markWorkFailed(pool: Pool, id: string, error: unknown): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'failed',
		        last_error = $2,
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL`,
    [id, message],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markWorkRetrying(pool: Pool, id: string, error: unknown): Promise<boolean> {
  const message = sanitizeWorkError(error);
  const result = await pool.query(
    `UPDATE agent_work_items
		    SET status = 'queued',
		        last_error = $2,
		        updated_at = now()
		  WHERE id = $1
		    AND status = 'running'
		    AND cancel_requested_at IS NULL`,
    [id, message],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markWorkCancelled(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `UPDATE agent_work_items
		    SET status = 'cancelled',
		        completed_at = now(),
		        updated_at = now()
		  WHERE id = $1
		    AND status IN ('queued', 'running')`,
    [id],
  );
}

export async function shouldSkipWork(pool: Pool, item: AgentWorkItem): Promise<boolean> {
  const row = await queryOne<{ status: WorkStatus; cancel_requested_at: Date | null }>(
    pool,
    "SELECT status, cancel_requested_at FROM agent_work_items WHERE id = $1",
    [item.id],
  );
  return (
    !row ||
    row.status === "superseded" ||
    row.status === "cancelled" ||
    row.cancel_requested_at != null
  );
}

export async function hasPriorCompletedSummaryPublish(
  pool: Pool,
  resourceKey: string,
  reviewLens: ReviewWorkPayload["mode"],
  excludeWorkItemId: string,
): Promise<boolean> {
  const row = await queryOne<{ exists: number }>(
    pool,
    `SELECT 1 AS exists
		   FROM publish_records
		  WHERE resource_key = $1
		    AND review_lens = $2
		    AND step = 'summary_comment'
		    AND status = 'completed'
		    AND work_item_id <> $3
		  LIMIT 1`,
    [resourceKey, reviewLens, excludeWorkItemId],
  );
  return row != null;
}

export async function getSummaryCommentGithubId(
  pool: Pool,
  resourceKey: string,
  reviewLens: ReviewWorkPayload["mode"],
): Promise<number | null> {
  const row = await queryOne<{ github_id: string }>(
    pool,
    `SELECT github_id
		   FROM publish_records
		  WHERE resource_key = $1
		    AND review_lens = $2
		    AND step IN ('summary_comment', 'progress_comment')
		    AND status = 'completed'
		    AND github_id IS NOT NULL
		  ORDER BY updated_at DESC
		  LIMIT 1`,
    [resourceKey, reviewLens],
  );
  if (!row?.github_id) return null;
  const id = Number(row.github_id);
  return Number.isFinite(id) ? id : null;
}

export async function getReviewPublishState(
  pool: Pool,
  workItemId: string,
  resourceKey: string,
  reviewLens: ReviewWorkPayload["mode"],
): Promise<{
  inlinePublished: boolean;
  summaryPublished: boolean;
  inlineReviewId: number | null;
}> {
  const { rows } = await pool.query<{ step: string; github_id: string | null }>(
    `SELECT step, github_id
		   FROM publish_records
		  WHERE resource_key = $1
		    AND review_lens = $2
		    AND work_item_id = $3
		    AND status = 'completed'
		    AND step IN ('inline_review', 'summary_comment')`,
    [resourceKey, reviewLens, workItemId],
  );
  const steps = new Set(rows.map((r) => r.step));
  const inlineRow = rows.find((r) => r.step === "inline_review");
  const inlineReviewId =
    inlineRow?.github_id != null && Number.isFinite(Number(inlineRow.github_id))
      ? Number(inlineRow.github_id)
      : null;
  return {
    inlinePublished: steps.has("inline_review"),
    summaryPublished: steps.has("summary_comment"),
    inlineReviewId,
  };
}

export async function getStoredInlineFingerprints(
  pool: Pool,
  resourceKey: string,
  reviewLens: ReviewWorkPayload["mode"],
): Promise<string[]> {
  const { rows } = await pool.query<{ detail: Record<string, unknown> }>(
    `SELECT detail
       FROM publish_records
      WHERE resource_key = $1
        AND review_lens = $2
        AND step = 'inline_review'
        AND status = 'completed'`,
    [resourceKey, reviewLens],
  );
  const merged = new Set<string>();
  for (const row of rows) {
    for (const fingerprint of parseStoredInlineFingerprints(row.detail).fingerprints) {
      merged.add(fingerprint);
    }
  }
  return [...merged];
}

export async function recordPublishStep(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: PublishLens;
    step: PublishStep;
    githubId?: string | number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, detail)
		 VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb)
		 ON CONFLICT (resource_key, review_lens, step)
		 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
		               github_id = EXCLUDED.github_id,
		               status = 'completed',
		               detail = EXCLUDED.detail,
		               updated_at = now()`,
    [
      crypto.randomUUID(),
      params.workItemId,
      params.resourceKey,
      params.reviewLens,
      params.step,
      params.githubId == null ? null : String(params.githubId),
      JSON.stringify(params.detail ?? {}),
    ],
  );
}
