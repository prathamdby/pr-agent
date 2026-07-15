import crypto from "node:crypto";
import type { Pool } from "pg";
import { queryOne } from "../db/postgres.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { parseStoredInlineFingerprints } from "../review/findings/reviewFindingFingerprint.js";
import {
  ASK_PUBLISH_LENS,
  DESCRIPTION_PUBLISH_LENS,
  TRIAGE_PUBLISH_LENS,
  VERIFICATION_PUBLISH_LENS,
} from "../settings/index.js";
import type {
  AgentWorkItem,
  AgentWorkItemCore,
  ReviewWorkPayload,
  WorkStatus,
  WorkType,
} from "./types.js";
import { attachWorkItemPayload, WorkItemPayloadValidationError } from "./workItemPayloadSchema.js";

export type PublishLens =
  | ReviewWorkPayload["mode"]
  | typeof DESCRIPTION_PUBLISH_LENS
  | typeof ASK_PUBLISH_LENS
  | typeof TRIAGE_PUBLISH_LENS
  | typeof VERIFICATION_PUBLISH_LENS;
type SharedPublishLens = Exclude<PublishLens, typeof ASK_PUBLISH_LENS>;
export type PublishStep =
  | "progress_comment"
  | "inline_review"
  | "summary_comment"
  | "summary_comment_claim"
  | "check_run"
  | "labels"
  | "pr_body"
  | "ask_reply"
  | "triage_push"
  | "triage_thread_actions"
  | "triage_report"
  | "verification_thread_actions";
type SharedPublishStep = Exclude<PublishStep, "ask_reply" | "check_run">;
type AskPublishStep = Extract<PublishStep, "ask_reply">;

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
  review_lens: "review" | "review-security" | "review-quality" | "review-tests" | null;
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
      return {
        ...base,
        type: "review",
        source: row.source,
        reviewLens: row.review_lens,
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

async function terminalizeInvalidClaimedWorkItem(
  pool: Pool,
  id: string,
  error: unknown,
): Promise<never> {
  await markWorkFailed(pool, id, error);
  throw error;
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

const CLAIM_QUEUED_WORK_ITEM_RETURNING = `id, webhook_event_id, type, source, status, owner, repo, pr_number, installation_id, head_sha,
		        review_lens, resource_key, attempt_count, payload, cancel_requested_at`;

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

/** One-query claim: UPDATE queued→running and return the full item; null = not claimable this way. */
export async function claimQueuedWorkItem<T extends WorkType>(
  pool: Pool,
  id: string,
  type: T,
): Promise<Extract<AgentWorkItem, { type: T }> | null> {
  const row = await queryOne<AgentWorkRow>(
    pool,
    `UPDATE agent_work_items
		    SET status = 'running',
		        started_at = COALESCE(started_at, now()),
		        attempt_count = attempt_count + 1,
		        updated_at = now()
		  WHERE id = $1
		    AND type = $2
		    AND status = 'queued'
		    AND cancel_requested_at IS NULL
		  RETURNING ${CLAIM_QUEUED_WORK_ITEM_RETURNING}`,
    [id, type],
  );
  if (!row) return null;
  try {
    return mapWorkItem(row) as Extract<AgentWorkItem, { type: T }>;
  } catch (error) {
    return await terminalizeInvalidClaimedWorkItem(pool, id, error);
  }
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

export async function getCompletedPublishStepDetail(
  pool: Pool,
  workItemId: string,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ detail: Record<string, unknown> | null }>(
    pool,
    `SELECT detail
		   FROM publish_records
		  WHERE work_item_id = $1
		    AND resource_key = $2
		    AND review_lens = $3
		    AND step = $4
		    AND status = 'completed'
		  LIMIT 1`,
    [workItemId, resourceKey, reviewLens, step],
  );
  return row?.detail ?? null;
}

export async function getCompletedPublishStepDetailWithoutNewerStep(
  pool: Pool,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
  newerStep: PublishStep,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ detail: Record<string, unknown> | null }>(
    pool,
    `SELECT current_step.detail
       FROM publish_records current_step
      WHERE current_step.resource_key = $1
        AND current_step.review_lens = $2
        AND current_step.step = $3
        AND current_step.status = 'completed'
        AND NOT EXISTS (
          SELECT 1
            FROM publish_records newer_step
           WHERE newer_step.resource_key = current_step.resource_key
             AND newer_step.review_lens = current_step.review_lens
             AND newer_step.step = $4
             AND newer_step.status = 'completed'
             AND newer_step.updated_at >= current_step.updated_at
        )
      ORDER BY current_step.updated_at DESC
      LIMIT 1`,
    [resourceKey, reviewLens, step, newerStep],
  );
  return row?.detail ?? null;
}

/** Returns true exactly once per (resourceKey, lens) until the claim row is deleted. */
export async function claimSummaryCommentCreation(
  pool: Pool,
  workItemId: string,
  resourceKey: string,
  reviewLens: ReviewWorkPayload["mode"],
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, detail)
     VALUES ($1, $2, $3, $4, 'summary_comment_claim', 'completed', '{}'::jsonb)
	     ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
     DO NOTHING`,
    [crypto.randomUUID(), workItemId, resourceKey, reviewLens],
  );
  return (result.rowCount ?? 0) > 0;
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

export async function getReviewCheckRunGithubId(
  pool: Pool,
  workItemId: string,
  reviewLens: ReviewWorkPayload["mode"],
): Promise<number | null> {
  const row = await queryOne<{ github_id: string | null }>(
    pool,
    `SELECT github_id
		   FROM publish_records
		  WHERE work_item_id = $1
		    AND review_lens = $2
		    AND step = 'check_run'
		    AND github_id IS NOT NULL
		  LIMIT 1`,
    [workItemId, reviewLens],
  );
  if (!row?.github_id) return null;
  const id = Number(row.github_id);
  return Number.isFinite(id) ? id : null;
}

export async function reserveReviewCheckRun(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: ReviewWorkPayload["mode"];
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, detail)
			 VALUES ($1, $2, $3, $4, 'check_run', 'pending', $5::jsonb)
			 ON CONFLICT (work_item_id, review_lens, step) WHERE step = 'check_run'
			 DO NOTHING`,
    [
      crypto.randomUUID(),
      params.workItemId,
      params.resourceKey,
      params.reviewLens,
      JSON.stringify(params.detail ?? {}),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function recordReviewCheckRun(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: ReviewWorkPayload["mode"];
    githubId: string | number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, detail)
			 VALUES ($1, $2, $3, $4, 'check_run', $5, 'completed', $6::jsonb)
			 ON CONFLICT (work_item_id, review_lens, step) WHERE step = 'check_run'
			 DO UPDATE SET resource_key = EXCLUDED.resource_key,
			               github_id = EXCLUDED.github_id,
			               status = 'completed',
			               detail = publish_records.detail || EXCLUDED.detail,
			               updated_at = now()`,
    [
      crypto.randomUUID(),
      params.workItemId,
      params.resourceKey,
      params.reviewLens,
      String(params.githubId),
      JSON.stringify(params.detail ?? {}),
    ],
  );
}

export async function releaseUnstartedReviewCheckRunReservation(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: ReviewWorkPayload["mode"];
    staleBefore?: Date;
  },
): Promise<boolean> {
  const values: unknown[] = [params.workItemId, params.resourceKey, params.reviewLens];
  const staleClause =
    params.staleBefore == null
      ? ""
      : (() => {
          values.push(params.staleBefore);
          return `AND updated_at < $${values.length}`;
        })();
  const result = await pool.query(
    `DELETE FROM publish_records
		  WHERE work_item_id = $1
		    AND resource_key = $2
		    AND review_lens = $3
		    AND step = 'check_run'
		    AND status = 'pending'
		    AND github_id IS NULL
		    ${staleClause}`,
    values,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listTriageEligibleInlineReviews(
  pool: Pool,
  resourceKey: string,
): Promise<Map<number, ReviewWorkPayload["mode"]>> {
  const result = await pool.query<{ github_id: string; review_lens: ReviewWorkPayload["mode"] }>(
    `SELECT github_id, review_lens
       FROM publish_records
      WHERE resource_key = $1
        AND step = 'inline_review'
        AND status = 'completed'
        AND review_lens IN ('review', 'review-security', 'review-quality', 'review-tests')`,
    [resourceKey],
  );
  const reviewLenses = new Map<number, ReviewWorkPayload["mode"]>();
  for (const row of result.rows) {
    if (!row.github_id) continue;
    const reviewId = Number(row.github_id);
    if (Number.isFinite(reviewId) && reviewId > 0) {
      reviewLenses.set(reviewId, row.review_lens);
    }
  }
  return reviewLenses;
}

export async function hasStoredInlineReviewId(
  pool: Pool,
  resourceKey: string,
  pullRequestReviewId: number,
): Promise<boolean> {
  const row = await queryOne<{ exists: number }>(
    pool,
    `SELECT 1 AS exists
       FROM publish_records
      WHERE resource_key = $1
        AND step = 'inline_review'
        AND status = 'completed'
        AND github_id = $2
      LIMIT 1`,
    [resourceKey, String(pullRequestReviewId)],
  );
  return row != null;
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
    reviewLens: SharedPublishLens;
    step: SharedPublishStep;
    githubId?: string | number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, detail)
			 VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb)
				 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
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

export async function recordAskPublishStep(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    step: AskPublishStep;
    githubId?: string | number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, detail)
			 VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb)
			 ON CONFLICT (work_item_id, review_lens, step) WHERE review_lens = 'ask'
			 DO UPDATE SET resource_key = EXCLUDED.resource_key,
			               github_id = EXCLUDED.github_id,
			               status = 'completed',
			               detail = EXCLUDED.detail,
			               updated_at = now()`,
    [
      crypto.randomUUID(),
      params.workItemId,
      params.resourceKey,
      ASK_PUBLISH_LENS,
      params.step,
      params.githubId == null ? null : String(params.githubId),
      JSON.stringify(params.detail ?? {}),
    ],
  );
}
