import crypto from "node:crypto";
import type { Pool } from "pg";
import { queryOne } from "../db/postgres.js";
import { parseStoredInlineFingerprints } from "../review/findings/reviewFindingFingerprint.js";
import {
  ASK_PUBLISH_LENS,
  DESCRIPTION_PUBLISH_LENS,
  TRIAGE_PUBLISH_LENS,
  VERIFICATION_PUBLISH_LENS,
} from "../settings/index.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";

export type PublishLens =
  | AnyReviewLens
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
  reviewLens: AnyReviewLens,
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
  reviewLens: AnyReviewLens,
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
  reviewLens: AnyReviewLens,
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
    reviewLens: AnyReviewLens;
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
    reviewLens: AnyReviewLens;
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
    reviewLens: AnyReviewLens;
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
): Promise<Map<number, AnyReviewLens>> {
  const result = await pool.query<{ github_id: string; review_lens: AnyReviewLens }>(
    `SELECT github_id, review_lens
       FROM publish_records
      WHERE resource_key = $1
        AND step = 'inline_review'
        AND status = 'completed'
        AND review_lens IN ('review', 'review-security', 'review-quality', 'review-tests')`,
    [resourceKey],
  );
  const reviewLenses = new Map<number, AnyReviewLens>();
  for (const row of result.rows) {
    if (!row.github_id) continue;
    const reviewId = Number(row.github_id);
    if (Number.isFinite(reviewId) && reviewId > 0) {
      reviewLenses.set(reviewId, row.review_lens);
    }
  }
  return reviewLenses;
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
  reviewLens: AnyReviewLens,
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
