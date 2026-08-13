import crypto from "node:crypto";
import * as v from "valibot";
import type { IntakeClient } from "../db/postgres.js";
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
import {
  isJsonObject,
  isJsonString,
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../util/jsonValue.js";
import { assertCurrentExecutionEpoch } from "./workItemStateRepository.js";

export type PublishLens =
  | AnyReviewLens
  | typeof DESCRIPTION_PUBLISH_LENS
  | typeof ASK_PUBLISH_LENS
  | typeof TRIAGE_PUBLISH_LENS
  | typeof VERIFICATION_PUBLISH_LENS;
type SharedPublishLens = Exclude<PublishLens, typeof ASK_PUBLISH_LENS>;

function parseOptionalJsonObject(value: JsonValue | null | undefined): JsonObject | null {
  if (value == null) return null;
  const parsed = v.safeParse(jsonObjectSchema, value);
  return parsed.success ? parsed.output : null;
}

const storedPublishRowSchema = v.object({
  step: v.string(),
  github_id: v.optional(v.nullable(v.string())),
  detail: v.optional(v.nullable(jsonObjectSchema)),
});

const fingerprintDetailRowSchema = v.object({
  detail: v.optional(v.nullable(jsonObjectSchema)),
});
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
  pool: IntakeClient,
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
  pool: IntakeClient,
  workItemId: string,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
): Promise<JsonObject | null> {
  const row = await queryOne<{ detail: JsonValue | null }>(
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
  return parseOptionalJsonObject(row?.detail);
}

export async function getCompletedPublishStepDetailWithoutNewerStep(
  pool: IntakeClient,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
  newerStep: PublishStep,
): Promise<JsonObject | null> {
  const row = await queryOne<{ detail: JsonValue | null }>(
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
  return parseOptionalJsonObject(row?.detail);
}

/** Returns true exactly once per (resourceKey, lens) until the claim row is deleted. */
export async function claimSummaryCommentCreation(
  pool: IntakeClient,
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
  pool: IntakeClient,
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

/** Current progress-comment owner for a PR resource (any status). */
export async function getProgressCommentOwner(
  pool: IntakeClient,
  resourceKey: string,
  reviewLens: AnyReviewLens,
): Promise<{ readonly workItemId: string; readonly generation: number } | null> {
  const row = await queryOne<{ work_item_id: string; generation: number | null }>(
    pool,
    `SELECT work_item_id, (detail->>'progressGeneration')::integer AS generation
       FROM publish_records
      WHERE resource_key = $1
        AND review_lens = $2
        AND step = 'progress_comment'
      LIMIT 1`,
    [resourceKey, reviewLens],
  );
  if (row == null) return null;
  return {
    workItemId: row.work_item_id,
    generation: row.generation == null || !Number.isFinite(row.generation) ? 0 : row.generation,
  };
}

export async function getProgressCommentRevision(
  pool: IntakeClient,
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
  pool: IntakeClient,
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
  pool: IntakeClient,
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
  pool: IntakeClient,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    detail?: JsonObject;
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
  pool: IntakeClient,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    githubId: string | number;
    detail?: JsonObject;
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
  pool: IntakeClient,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    staleBefore?: Date;
  },
): Promise<boolean> {
  const values: Array<string | Date> = [params.workItemId, params.resourceKey, params.reviewLens];
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
  pool: IntakeClient,
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

function mergeStoredInlineFingerprints(rows: readonly { detail: JsonObject }[]): string[] {
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

function parseStoredPlacement(value: JsonValue): StoredInlineBatchRef["placements"][number] | null {
  if (!isJsonObject(value)) return null;
  const finding = v.safeParse(reviewFindingSchema, value.finding);
  const resolvedLine = Number(value.resolvedLine);
  const fingerprint = value.canonicalFingerprint;
  if (
    !finding.success ||
    !Number.isInteger(resolvedLine) ||
    resolvedLine <= 0 ||
    !v.is(v.string(), fingerprint)
  ) {
    return null;
  }
  return {
    finding: finding.output,
    resolvedLine,
    canonicalFingerprint: fingerprint,
  };
}

export function parseStoredInlineBatches(detail: JsonObject): StoredInlineBatchRef[] {
  if (!Array.isArray(detail.batches)) return [];
  const batches: StoredInlineBatchRef[] = [];
  for (const value of detail.batches) {
    if (!isJsonObject(value)) continue;
    const workItemId = value.workItemId;
    if (!v.is(v.string(), workItemId)) continue;
    const reviewId = Number(value.reviewId);
    batches.push({
      workItemId,
      reviewId: Number.isFinite(reviewId) && reviewId > 0 ? reviewId : null,
      fingerprints: Array.isArray(value.fingerprints)
        ? value.fingerprints.filter((entry): entry is string => isJsonString(entry))
        : [],
      source:
        value.specialist !== undefined && isFindingSource(value.specialist)
          ? value.specialist
          : null,
      placements: Array.isArray(value.placements)
        ? value.placements.flatMap((placement) => {
            const parsed = parseStoredPlacement(placement);
            return parsed == null ? [] : [parsed];
          })
        : [],
    });
  }
  return batches;
}

function parseResumedPlacements(
  rows: readonly { step: string; detail?: JsonObject | null }[],
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

type ReviewPublishState = {
  summaryPublished: boolean;
  inlineReviewIds: number[];
  threadCallCount: number;
};

function parseReviewPublishStateRows(
  rows: readonly {
    step: string;
    github_id: string | null;
    detail?: JsonObject | null;
  }[],
  workItemId: string,
): ReviewPublishState {
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
  publishState: ReviewPublishState;
  shouldLinkToSummary: boolean;
  storedInlineFingerprints: string[];
  resumedPlacements: AcceptedPlacement[];
  progressCommentGithubId: number | null;
};

export async function loadReviewExecutorPublishContext(
  pool: IntakeClient,
  workItemId: string,
  resourceKey: string,
  reviewLens: AnyReviewLens,
): Promise<ReviewExecutorPublishContext> {
  const row = await queryOne<{
    current_publish: JsonValue | null;
    prior_summary_exists: boolean;
    fingerprint_details: JsonValue | null;
    latest_progress_comment_github_id: string | null;
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
       ) AS latest_progress_comment_github_id`,
    [resourceKey, reviewLens, workItemId],
  );
  const currentPublish = v
    .parse(v.array(storedPublishRowSchema), row?.current_publish ?? [])
    .map((entry) => ({
      step: entry.step,
      github_id: entry.github_id ?? null,
      detail: entry.detail ?? null,
    }));
  const fingerprintDetails = v
    .parse(v.array(fingerprintDetailRowSchema), row?.fingerprint_details ?? [])
    .map((entry) => ({ detail: entry.detail ?? {} }));
  const shouldLinkToSummary = row?.prior_summary_exists ?? false;
  const progressCommentGithubId =
    row?.latest_progress_comment_github_id != null
      ? Number(row.latest_progress_comment_github_id)
      : null;
  return {
    publishState: parseReviewPublishStateRows(currentPublish, workItemId),
    shouldLinkToSummary,
    storedInlineFingerprints: mergeStoredInlineFingerprints(fingerprintDetails),
    resumedPlacements: parseResumedPlacements(currentPublish, workItemId),
    progressCommentGithubId:
      progressCommentGithubId != null && Number.isFinite(progressCommentGithubId)
        ? progressCommentGithubId
        : null,
  };
}

export async function recordPublishStep(
  pool: IntakeClient,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: SharedPublishLens;
    step: SharedPublishStep;
    githubId?: string | number;
    detail?: JsonObject;
    /**
     * Claim epoch that owns this write. Pass `null` only for pre-claim writers
     * (e.g. ack progress stubs); durable executors must pass the live epoch.
     */
    executionEpoch: number | null;
  },
): Promise<void> {
  if (params.executionEpoch != null) {
    await assertCurrentExecutionEpoch(pool, params.workItemId, params.executionEpoch);
  }
  let detail: JsonObject = params.detail ?? {};
  if (
    params.step === "inline_review" &&
    params.detail != null &&
    v.is(v.string(), params.detail.batchId)
  ) {
    detail = { batches: [params.detail] };
  }
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
			                 WHEN EXCLUDED.step = 'progress_comment'
			                 THEN COALESCE(publish_records.detail, '{}'::jsonb) || EXCLUDED.detail
			                 ELSE EXCLUDED.detail
			               END,
			               updated_at = now()
			         WHERE publish_records.step <> 'progress_comment'
			            OR publish_records.work_item_id = EXCLUDED.work_item_id`,
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
  pool: IntakeClient,
  params: {
    workItemId: string;
    resourceKey: string;
    step: AskPublishStep;
    githubId?: string | number;
    detail?: JsonObject;
    executionEpoch: number | null;
  },
): Promise<void> {
  if (params.executionEpoch != null) {
    await assertCurrentExecutionEpoch(pool, params.workItemId, params.executionEpoch);
  }
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
