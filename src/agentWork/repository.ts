import crypto from "node:crypto";
import type { Pool } from "pg";
import { queryOne } from "../db/postgres.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { parseStoredInlineFingerprints } from "../review/reviewFindingFingerprint.js";
import { ASK_PUBLISH_LENS, DESCRIPTION_PUBLISH_LENS } from "../settings/index.js";
import type { AgentWorkItem, AgentWorkItemCore, ReviewWorkPayload, WorkStatus } from "./types.js";

export type PublishLens =
  | ReviewWorkPayload["mode"]
  | typeof DESCRIPTION_PUBLISH_LENS
  | typeof ASK_PUBLISH_LENS;
export type PublishStep =
  | "progress_comment"
  | "inline_review"
  | "summary_comment"
  | "labels"
  | "pr_body"
  | "ask_reply";

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
  return { ...mapWorkItemCore(row), payload: row.payload };
}

function mapWorkItemCore(row: Omit<AgentWorkRow, "payload">): AgentWorkItemCore {
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

export async function getWorkItemPayload(
  pool: Pool,
  id: string,
): Promise<AgentWorkItem["payload"] | null> {
  const row = await queryOne<{ payload: AgentWorkItem["payload"] }>(
    pool,
    "SELECT payload FROM agent_work_items WHERE id = $1",
    [id],
  );
  return row?.payload ?? null;
}

function sanitizeWorkError(error: unknown): string {
  return sanitizeLogMessage(error instanceof Error ? error.message : String(error));
}

async function markWorkRunning(pool: Pool, id: string): Promise<boolean> {
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
  const row = await queryOne<{
    status: WorkStatus;
    cancel_requested_at: Date | null;
  }>(pool, "SELECT status, cancel_requested_at FROM agent_work_items WHERE id = $1", [id]);
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

export async function shouldSkipWork(
  pool: Pool,
  item: Pick<AgentWorkItem, "id">,
): Promise<boolean> {
  const row = await queryOne<{
    status: WorkStatus;
    cancel_requested_at: Date | null;
  }>(pool, "SELECT status, cancel_requested_at FROM agent_work_items WHERE id = $1", [item.id]);
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

export async function hasCompletedPublishStep(
  pool: Pool,
  workItemId: string,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
): Promise<boolean> {
  const row = await queryOne<{ exists: number }>(
    pool,
    `SELECT 1 AS exists
		   FROM publish_records
		  WHERE work_item_id = $1
		    AND resource_key = $2
		    AND review_lens = $3
		    AND step = $4
		    AND status = 'completed'
		  LIMIT 1`,
    [workItemId, resourceKey, reviewLens, step],
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
  return mergeStoredInlineFingerprints(rows);
}

function mergeStoredInlineFingerprints(
  rows: readonly { detail: Record<string, unknown> }[],
): string[] {
  const merged = new Set<string>();
  for (const row of rows) {
    for (const fingerprint of parseStoredInlineFingerprints(row.detail).fingerprints) {
      merged.add(fingerprint);
    }
  }
  return [...merged];
}

function parseReviewPublishStateRows(rows: readonly { step: string; github_id: string | null }[]): {
  inlinePublished: boolean;
  summaryPublished: boolean;
  inlineReviewId: number | null;
} {
  const steps = new Set(rows.map((row) => row.step));
  const inlineRow = rows.find((row) => row.step === "inline_review");
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

export type ReviewExecutorPublishContext = {
  publishState: {
    inlinePublished: boolean;
    summaryPublished: boolean;
    inlineReviewId: number | null;
  };
  shouldLinkToSummary: boolean;
  storedInlineFingerprints: string[];
  summaryCommentGithubId: number | null;
};

export async function loadReviewExecutorPublishContext(
  pool: Pool,
  workItemId: string,
  resourceKey: string,
  reviewLens: ReviewWorkPayload["mode"],
): Promise<ReviewExecutorPublishContext> {
  const row = await queryOne<{
    current_publish: { step: string; github_id: string | null }[] | null;
    prior_summary_exists: boolean;
    fingerprint_details: { detail: Record<string, unknown> }[] | null;
    latest_summary_github_id: string | null;
  }>(
    pool,
    `SELECT
       COALESCE(
         (
           SELECT json_agg(json_build_object('step', step, 'github_id', github_id))
             FROM publish_records
            WHERE resource_key = $1
              AND review_lens = $2
              AND work_item_id = $3
              AND status = 'completed'
              AND step IN ('inline_review', 'summary_comment')
         ),
         '[]'::json
       ) AS current_publish,
       EXISTS (
         SELECT 1
           FROM publish_records
          WHERE resource_key = $1
            AND review_lens = $2
            AND step = 'summary_comment'
            AND status = 'completed'
            AND work_item_id <> $3
       ) AS prior_summary_exists,
       COALESCE(
         (
           SELECT json_agg(json_build_object('detail', detail))
             FROM publish_records
            WHERE resource_key = $1
              AND review_lens = $2
              AND step = 'inline_review'
              AND status = 'completed'
         ),
         '[]'::json
       ) AS fingerprint_details,
       (
         SELECT github_id
           FROM publish_records
          WHERE resource_key = $1
            AND review_lens = $2
            AND step IN ('summary_comment', 'progress_comment')
            AND status = 'completed'
            AND github_id IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
       ) AS latest_summary_github_id`,
    [resourceKey, reviewLens, workItemId],
  );
  const currentPublish = row?.current_publish ?? [];
  const shouldLinkToSummary = row?.prior_summary_exists ?? false;
  const summaryCommentGithubId =
    shouldLinkToSummary && row?.latest_summary_github_id
      ? Number(row.latest_summary_github_id)
      : null;
  return {
    publishState: parseReviewPublishStateRows(currentPublish),
    shouldLinkToSummary,
    storedInlineFingerprints: mergeStoredInlineFingerprints(row?.fingerprint_details ?? []),
    summaryCommentGithubId:
      summaryCommentGithubId != null && Number.isFinite(summaryCommentGithubId)
        ? summaryCommentGithubId
        : null,
  };
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
