import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { queryOne } from "../db/postgres.js";
import { parseStoredInlineFingerprints } from "../review/findings/reviewFindingFingerprint.js";
import {
  isFindingSource,
  type AcceptedPlacement,
  type FindingSource,
} from "../review/orchestrator/orchestratorTypes.js";
import { reviewFindingSchema, type ReviewFinding } from "../review/reviewSchema.js";
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
  pool: Pool | PoolClient,
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
  pool: Pool | PoolClient,
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

export async function getProgressCommentRevision(
  pool: Pool | PoolClient,
  resourceKey: string,
  reviewLens: AnyReviewLens,
): Promise<{ readonly workItemId: string; readonly revision: number } | null> {
  const row = await queryOne<{ work_item_id: string; revision: number | null }>(
    pool,
    `SELECT work_item_id, (detail->>'progressRevision')::integer AS revision
       FROM publish_records
      WHERE resource_key = $1
        AND review_lens = $2
        AND step = 'progress_comment'
        AND status = 'completed'
        AND jsonb_typeof(detail->'progressRevision') = 'number'
      LIMIT 1`,
    [resourceKey, reviewLens],
  );
  return row?.revision == null ? null : { workItemId: row.work_item_id, revision: row.revision };
}

/** Epoch ms when the progress stub (revision 0) was first recorded, if known. */
export async function getProgressStubPostedAtMs(
  pool: Pool | PoolClient,
  resourceKey: string,
  reviewLens: AnyReviewLens,
): Promise<number | null> {
  const row = await queryOne<{ stub_posted_at_ms: string | number | null }>(
    pool,
    `SELECT detail->>'stubPostedAtMs' AS stub_posted_at_ms
       FROM publish_records
      WHERE resource_key = $1
        AND review_lens = $2
        AND step = 'progress_comment'
        AND status = 'completed'
        AND jsonb_typeof(detail->'stubPostedAtMs') = 'number'
      LIMIT 1`,
    [resourceKey, reviewLens],
  );
  if (row?.stub_posted_at_ms == null) return null;
  const value = Number(row.stub_posted_at_ms);
  return Number.isFinite(value) ? value : null;
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
    for (const batch of parseStoredInlineBatches(row.detail)) {
      for (const fingerprint of batch.fingerprints) {
        merged.add(fingerprint);
      }
    }
  }
  return [...merged];
}

type StoredInlineBatchRef = {
  readonly workItemId: string;
  readonly reviewId: number | null;
  readonly fingerprints: readonly string[];
  readonly source: FindingSource | null;
  readonly placements: readonly {
    readonly finding: ReviewFinding;
    readonly resolvedLine: number;
    readonly canonicalFingerprint: string;
  }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function parseStoredPlacement(value: unknown): StoredInlineBatchRef["placements"][number] | null {
  if (!isRecord(value)) return null;
  const finding = reviewFindingSchema.safeParse(value.finding);
  const resolvedLine = Number(value.resolvedLine);
  if (
    !finding.success ||
    !Number.isInteger(resolvedLine) ||
    resolvedLine <= 0 ||
    typeof value.canonicalFingerprint !== "string"
  ) {
    return null;
  }
  return {
    finding: finding.data,
    resolvedLine,
    canonicalFingerprint: value.canonicalFingerprint,
  };
}

function parseStoredInlineBatches(detail: Record<string, unknown>): StoredInlineBatchRef[] {
  if (!Array.isArray(detail.batches)) return [];
  const batches: StoredInlineBatchRef[] = [];
  for (const value of detail.batches) {
    if (!isRecord(value)) continue;
    const batch = value;
    if (typeof batch.workItemId !== "string") continue;
    const reviewId = Number(batch.reviewId);
    batches.push({
      workItemId: batch.workItemId,
      reviewId: Number.isFinite(reviewId) && reviewId > 0 ? reviewId : null,
      fingerprints: Array.isArray(batch.fingerprints)
        ? batch.fingerprints.filter((entry): entry is string => typeof entry === "string")
        : [],
      source: isFindingSource(batch.specialist) ? batch.specialist : null,
      placements: Array.isArray(batch.placements)
        ? batch.placements.flatMap((placement) => {
            const parsed = parseStoredPlacement(placement);
            return parsed == null ? [] : [parsed];
          })
        : [],
    });
  }
  return batches;
}

function parseResumedPlacements(
  rows: readonly { step: string; detail?: Record<string, unknown> | null }[],
  workItemId: string,
): AcceptedPlacement[] {
  const inlineRow = rows.find((row) => row.step === "inline_review");
  const accepted: AcceptedPlacement[] = [];
  const seen = new Set<string>();
  for (const batch of parseStoredInlineBatches(inlineRow?.detail ?? {})) {
    if (batch.workItemId !== workItemId || batch.reviewId == null || batch.source == null) continue;
    for (const placement of batch.placements) {
      if (seen.has(placement.canonicalFingerprint)) continue;
      seen.add(placement.canonicalFingerprint);
      accepted.push({
        kind: "resumed",
        source: batch.source,
        placement: {
          finding: placement.finding,
          inlineLine: placement.resolvedLine,
          inlinePosted: true,
        },
        canonicalFingerprint: placement.canonicalFingerprint,
        reviewId: batch.reviewId,
      });
    }
  }
  return accepted;
}

function parseReviewPublishStateRows(
  rows: readonly {
    step: string;
    github_id: string | null;
    detail?: Record<string, unknown> | null;
  }[],
  workItemId: string,
): {
  summaryPublished: boolean;
  inlineReviewIds: number[];
  threadCallCount: number;
} {
  const steps = new Set(rows.map((row) => row.step));
  const inlineRow = rows.find((row) => row.step === "inline_review");
  const inlineReviewIds = new Set<number>();
  const batches = parseStoredInlineBatches(inlineRow?.detail ?? {});
  for (const batch of batches) {
    if (batch.workItemId === workItemId && batch.reviewId != null) {
      inlineReviewIds.add(batch.reviewId);
    }
  }
  if (batches.length === 0 && inlineRow?.github_id != null) {
    const legacyReviewId = Number(inlineRow.github_id);
    if (Number.isFinite(legacyReviewId) && legacyReviewId > 0) {
      inlineReviewIds.add(legacyReviewId);
    }
  }
  return {
    summaryPublished: steps.has("summary_comment"),
    inlineReviewIds: [...inlineReviewIds],
    threadCallCount:
      batches.filter((batch) => batch.workItemId === workItemId).length ||
      (batches.length === 0 && inlineReviewIds.size > 0 ? 1 : 0),
  };
}

export type ReviewExecutorPublishContext = {
  publishState: {
    summaryPublished: boolean;
    inlineReviewIds: number[];
    threadCallCount: number;
  };
  shouldLinkToSummary: boolean;
  storedInlineFingerprints: string[];
  resumedPlacements: AcceptedPlacement[];
  summaryCommentGithubId: number | null;
};

export async function loadReviewExecutorPublishContext(
  pool: Pool,
  workItemId: string,
  resourceKey: string,
  reviewLens: AnyReviewLens,
): Promise<ReviewExecutorPublishContext> {
  const row = await queryOne<{
    current_publish:
      | { step: string; github_id: string | null; detail: Record<string, unknown> | null }[]
      | null;
    prior_summary_exists: boolean;
    fingerprint_details: { detail: Record<string, unknown> }[] | null;
    latest_summary_github_id: string | null;
  }>(
    pool,
    `SELECT
       COALESCE(
         (
           SELECT json_agg(json_build_object('step', step, 'github_id', github_id, 'detail', detail))
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
              AND review_lens IN ('review', 'review-security', 'review-quality', 'review-tests')
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
    row?.latest_summary_github_id != null ? Number(row.latest_summary_github_id) : null;
  return {
    publishState: parseReviewPublishStateRows(currentPublish, workItemId),
    shouldLinkToSummary,
    storedInlineFingerprints: mergeStoredInlineFingerprints(row?.fingerprint_details ?? []),
    resumedPlacements: parseResumedPlacements(currentPublish, workItemId),
    summaryCommentGithubId:
      summaryCommentGithubId != null && Number.isFinite(summaryCommentGithubId)
        ? summaryCommentGithubId
        : null,
  };
}

export async function recordPublishStep(
  pool: Pool | PoolClient,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: SharedPublishLens;
    step: SharedPublishStep;
    githubId?: string | number;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const detail =
    params.step === "inline_review" && typeof params.detail?.batchId === "string"
      ? { batches: [params.detail] }
      : (params.detail ?? {});
  await pool.query(
    `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, detail)
			 VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb)
				 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
			 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
			               github_id = EXCLUDED.github_id,
			               status = 'completed',
			               detail = CASE
			                 WHEN EXCLUDED.step = 'inline_review'
			                      AND jsonb_typeof(EXCLUDED.detail->'batches') = 'array'
			                 THEN jsonb_set(
			                   COALESCE(publish_records.detail, '{}'::jsonb),
			                   '{batches}',
			                   CASE
			                     WHEN COALESCE(publish_records.detail->'batches', '[]'::jsonb) @>
			                          jsonb_build_array(jsonb_build_object(
			                            'batchId', EXCLUDED.detail #>> '{batches,0,batchId}'
			                          ))
			                     THEN COALESCE(publish_records.detail->'batches', '[]'::jsonb)
			                     ELSE COALESCE(publish_records.detail->'batches', '[]'::jsonb) ||
			                          (EXCLUDED.detail->'batches')
			                   END,
			                   true
			                 )
			                 ELSE EXCLUDED.detail
			               END,
			               updated_at = now()`,
    [
      crypto.randomUUID(),
      params.workItemId,
      params.resourceKey,
      params.reviewLens,
      params.step,
      params.githubId == null ? null : String(params.githubId),
      JSON.stringify(detail),
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
