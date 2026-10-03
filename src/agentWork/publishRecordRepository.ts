import { fencedWrite } from "./fencedWrite.js";
import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import * as v from "valibot";
import { queryOne } from "../db/postgres.js";
import { withSessionLock } from "../db/sessionLock.js";
import { AppError } from "../errors/appError.js";
import { logWarn } from "../evlog.js";
import { parseStoredInlineFingerprints } from "../review/findings/reviewFindingFingerprint.js";
import {
  isFindingSource,
  type AcceptedPlacement,
  type FindingSource,
} from "../review/orchestrator/orchestratorTypes.js";
import { reviewFindingSchema, type ReviewFinding } from "../review/reviewSchema.js";
import { DEFERRED_HEAD_SHA, type AnyReviewLens } from "../settings/index.js";
import { isRecord } from "../util/typeGuards.js";
import type { OperationIntentRow } from "./operationIntentRepository.js";

/** Returns true exactly once per (resourceKey, lens) until the claim row is deleted. */
export async function claimSummaryCommentCreation(
  pool: Pool | PoolClient,
  workItemId: string,
  resourceKey: string,
  reviewLens: AnyReviewLens,
  leaseEpoch?: number | null,
): Promise<boolean> {
  const result = await fencedWrite(
    pool,
    workItemId,
    leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      pool.query(
        `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, lease_epoch, detail)
     SELECT $1, $2, $3, $4, 'summary_comment_claim', 'completed', $5, '{}'::jsonb
      WHERE $5::bigint IS NULL OR EXISTS (
        SELECT 1 FROM pr_actor_leases
         WHERE work_item_id = $2 AND lease_epoch = $5
      )
	     ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
     DO NOTHING`,
        [crypto.randomUUID(), workItemId, resourceKey, reviewLens, leaseEpoch ?? null],
      ),
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

/** Current progress-comment owner for a PR resource (any status). */
export async function getProgressCommentOwner(
  pool: Pool | PoolClient,
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
  pool: Pool | PoolClient,
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

const selectedOwnVerdictSchema = v.object({
  conclusion: v.picklist(["success", "failure", "neutral", "cancelled", "action_required"]),
  summary: v.string(),
  detailsUrl: v.optional(v.string()),
  status: v.optional(
    v.object({
      headSha: v.string(),
      enabled: v.boolean(),
      state: v.picklist(["success", "failure", "error"]),
    }),
  ),
});

export type SelectedOwnVerdict = v.InferOutput<typeof selectedOwnVerdictSchema>;
type OwnVerdictIdentity = {
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: AnyReviewLens;
  readonly leaseEpoch?: number | null;
};

export function ownVerdictStatusApplicable(selected: SelectedOwnVerdict): boolean {
  return (
    selected.status != null &&
    selected.status.enabled &&
    selected.status.headSha.length > 0 &&
    selected.status.headSha !== DEFERRED_HEAD_SHA
  );
}

export async function getOwnVerdictCloseRecord(
  client: Pool | PoolClient,
  params: OwnVerdictIdentity,
) {
  const row = await queryOne<{ github_id: string | null; detail: Record<string, unknown> }>(
    client,
    `SELECT github_id, detail FROM publish_records
      WHERE work_item_id = $1 AND resource_key = $2 AND review_lens = $3 AND step = 'check_run'`,
    [params.workItemId, params.resourceKey, params.reviewLens],
  );
  if (row == null) return null;
  const parsed =
    row.detail.selectedOwnVerdict == null
      ? null
      : v.safeParse(selectedOwnVerdictSchema, row.detail.selectedOwnVerdict);
  if (parsed != null && !parsed.success)
    throw new AppError({
      domain: "agent_work",
      kind: "own_verdict_invalid",
      message: "Stored own verdict selection is invalid",
      context: { workItemId: params.workItemId, reviewLens: params.reviewLens },
    });
  return {
    selected: parsed?.success ? parsed.output : null,
    githubId: row.github_id == null ? null : Number(row.github_id),
    checkApplied: row.detail.ownCheckApplied === true,
    statusApplied: row.detail.ownStatusApplied === true,
    legacyClosed:
      parsed == null &&
      row.detail.status === "completed" &&
      typeof row.detail.conclusion === "string" &&
      row.detail.conclusion.length > 0,
  };
}

export function ownVerdictCloseOperationKey(params: OwnVerdictIdentity): string {
  return `review:check_run_close:${params.workItemId}:${params.reviewLens}`;
}

/**
 * The finish mutation delegated under this close's parent intent, if any. The
 * parent key is unique to the lane, so the boundary child is found by
 * parentage instead of replicating the boundary's input-hash encoding.
 */
export async function getDelegatedOwnVerdictFinish(
  client: Pool | PoolClient,
  params: OwnVerdictIdentity,
): Promise<Pick<OperationIntentRow, "status" | "detail"> | null> {
  return queryOne<Pick<OperationIntentRow, "status" | "detail">>(
    client,
    `SELECT status, detail FROM operation_intents
      WHERE work_item_id = $1
        AND mutation_kind = 'github.pr_surface.finishReviewCheck'
        AND detail->>'parentOperationKey' = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [params.workItemId, ownVerdictCloseOperationKey(params)],
  );
}

/**
 * Legacy finish intents block a fresh verdict selection only while they are
 * still actionable: accepted, awaiting recovery, or mid-mutation. An
 * outcome_unknown row the boundary already resolved `terminal` is inert
 * evidence — the terminal failure close must still run.
 */
export async function hasLegacyOwnVerdictCompletion(
  client: Pool | PoolClient,
  params: OwnVerdictIdentity,
): Promise<boolean> {
  const row = await queryOne<{ blocked: boolean }>(
    client,
    `SELECT EXISTS (
       SELECT 1 FROM operation_intents
        WHERE work_item_id = $1
          AND (mutation_kind = 'github.pr_surface.finishReviewCheck'
               OR detail->>'surfaceMethod' = 'finishReviewCheck')
          AND detail->>'parentOperationKey' IS DISTINCT FROM $2
          AND (status = 'reconciled'
               OR (status = 'outcome_unknown'
                   AND detail->>'unknownResolution' IS DISTINCT FROM 'terminal')
               OR detail ? '__result'
               OR (status <> 'failed' AND detail->'__mutating' = 'true'::jsonb))
     ) AS blocked`,
    [params.workItemId, ownVerdictCloseOperationKey(params)],
  );
  return row?.blocked === true;
}

export async function claimOwnVerdict(
  client: Pool | PoolClient,
  params: OwnVerdictIdentity & { readonly selected: SelectedOwnVerdict },
) {
  return fencedWrite(client, params.workItemId, params.leaseEpoch, { before: true }, async () => {
    const eligible = await queryOne<{ ok: number }>(
      client,
      `SELECT 1 AS ok FROM agent_work_items
      WHERE id = $1 AND type = 'review' AND resource_key = $2 AND review_lens = $3
        AND ($4::bigint IS NOT NULL OR status IN ('completed', 'failed', 'cancelled', 'superseded'))`,
      [params.workItemId, params.resourceKey, params.reviewLens, params.leaseEpoch ?? null],
    );
    if (eligible == null) return null;
    const existing = await getOwnVerdictCloseRecord(client, params);
    if (existing?.selected == null && (await hasLegacyOwnVerdictCompletion(client, params))) {
      logWarn("review_own_verdict_legacy_unresolved", {
        workItemId: params.workItemId,
        reviewLens: params.reviewLens,
      });
      return null;
    }
    await fencedWrite(
      client,
      params.workItemId,
      params.leaseEpoch,
      { before: false, rejected: (written) => (written.rowCount ?? 0) === 0 },
      () =>
        client.query(
          `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, lease_epoch, detail)
       SELECT $1, $2, $3, $4, 'check_run', 'pending', $5,
              jsonb_build_object('selectedOwnVerdict', $6::jsonb)
        WHERE EXISTS (
          SELECT 1 FROM agent_work_items WHERE id = $2 AND type = 'review'
            AND resource_key = $3 AND review_lens = $4
            AND ($5::bigint IS NOT NULL OR status IN ('completed', 'failed', 'cancelled', 'superseded'))
        ) AND ($5::bigint IS NULL OR EXISTS (
          SELECT 1 FROM pr_actor_leases WHERE work_item_id = $2 AND lease_epoch = $5
        ))
       ON CONFLICT (work_item_id, review_lens, step) WHERE step = 'check_run'
       DO UPDATE SET detail = publish_records.detail || EXCLUDED.detail, updated_at = now()
       WHERE publish_records.resource_key = EXCLUDED.resource_key
         AND NOT (publish_records.detail ? 'selectedOwnVerdict')
         AND COALESCE(publish_records.detail->>'conclusion', '') = ''
         AND (EXCLUDED.lease_epoch IS NULL OR EXISTS (
           SELECT 1 FROM pr_actor_leases WHERE work_item_id = EXCLUDED.work_item_id
             AND lease_epoch = EXCLUDED.lease_epoch
         ))`,
          [
            crypto.randomUUID(),
            params.workItemId,
            params.resourceKey,
            params.reviewLens,
            params.leaseEpoch ?? null,
            JSON.stringify(params.selected),
          ],
        ),
    );
    let record = await getOwnVerdictCloseRecord(client, params);
    if (
      record?.selected != null &&
      record.selected.status == null &&
      params.selected.status != null
    ) {
      const state =
        record.selected.conclusion === "failure"
          ? "failure"
          : record.selected.conclusion === "success"
            ? "success"
            : "error";
      const selected = {
        ...record.selected,
        status: { ...params.selected.status, state },
      } satisfies SelectedOwnVerdict;
      const selectedBeforeEnrichment = record.selected;
      const statusAlreadyApplied = record.statusApplied;
      await fencedWrite(client, params.workItemId, params.leaseEpoch, { before: false }, () =>
        client.query(
          `UPDATE publish_records SET detail = jsonb_set(detail, '{selectedOwnVerdict}', $4::jsonb)
             || CASE WHEN $7 THEN '{"status":"in_progress"}'::jsonb ELSE '{}'::jsonb END,
             updated_at = now()
        WHERE work_item_id = $1 AND resource_key = $2 AND review_lens = $3 AND step = 'check_run'
          AND detail->'selectedOwnVerdict' = $5::jsonb
          AND ($6::bigint IS NULL OR EXISTS (
            SELECT 1 FROM pr_actor_leases WHERE work_item_id = $1 AND lease_epoch = $6
          ))`,
          [
            params.workItemId,
            params.resourceKey,
            params.reviewLens,
            JSON.stringify(selected),
            JSON.stringify(selectedBeforeEnrichment),
            params.leaseEpoch ?? null,
            ownVerdictStatusApplicable(selected) && !statusAlreadyApplied,
          ],
        ),
      );
      record = await getOwnVerdictCloseRecord(client, params);
    }
    return record;
  });
}

export async function recordOwnVerdictSurfaceApplied(
  client: Pool | PoolClient,
  params: OwnVerdictIdentity & { readonly selected: SelectedOwnVerdict },
  surface: "check" | "status",
): Promise<void> {
  const check = surface === "check";
  const result = await fencedWrite(
    client,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      client.query(
        `UPDATE publish_records
        SET detail = detail || $4::jsonb || jsonb_build_object(
              'status', CASE WHEN ($5 OR detail->'ownCheckApplied' = 'true'::jsonb)
                 AND (NOT $6 OR $7 OR detail->'ownStatusApplied' = 'true'::jsonb)
                THEN 'completed' ELSE 'in_progress' END),
            updated_at = now()
      WHERE work_item_id = $1 AND resource_key = $2 AND review_lens = $3 AND step = 'check_run'
        AND detail->'selectedOwnVerdict' = $8::jsonb
        AND (NOT $5 OR github_id IS NOT NULL)
        AND ($9::bigint IS NULL OR EXISTS (
          SELECT 1 FROM pr_actor_leases WHERE work_item_id = $1 AND lease_epoch = $9
        ))`,
        [
          params.workItemId,
          params.resourceKey,
          params.reviewLens,
          JSON.stringify(
            check
              ? {
                  ownCheckApplied: true,
                  conclusion: params.selected.conclusion,
                  completedAt: new Date().toISOString(),
                  detailsUrl: params.selected.detailsUrl,
                }
              : { ownStatusApplied: true },
          ),
          check,
          ownVerdictStatusApplicable(params.selected),
          !check,
          JSON.stringify(params.selected),
          params.leaseEpoch ?? null,
        ],
      ),
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError({
      domain: "agent_work",
      kind: "own_verdict_receipt_rejected",
      message: "Own verdict acceptance receipt did not match its selection",
      context: { workItemId: params.workItemId, surface },
    });
  }
}

export async function withOwnVerdictClose<T>(
  pool: Pool,
  params: OwnVerdictIdentity,
  apply: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  return withSessionLock(
    pool,
    { kind: "own_verdict", workItemId: params.workItemId, reviewLens: params.reviewLens },
    {
      mode: "try",
      unleased: params.leaseEpoch == null,
      capacityError: () =>
        new AppError({
          domain: "agent_work",
          kind: "own_verdict_capacity",
          message: "Leased own verdict close requires nested database capacity",
          context: { workItemId: params.workItemId },
        }),
      onContended: (client) => getOwnVerdictCloseRecord(client, params),
    },
    apply,
  );
}

export async function reserveReviewCheckRun(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    leaseEpoch?: number | null;
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await fencedWrite(
    pool,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      pool.query(
        `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, status, lease_epoch, detail)
			 SELECT $1, $2, $3, $4, 'check_run', 'pending', $5, $6::jsonb
			  WHERE $5::bigint IS NULL OR EXISTS (
			    SELECT 1 FROM pr_actor_leases
			     WHERE work_item_id = $2 AND lease_epoch = $5
			  )
			 ON CONFLICT (work_item_id, review_lens, step) WHERE step = 'check_run'
			 DO UPDATE SET detail = publish_records.detail || EXCLUDED.detail,
                           lease_epoch = COALESCE(EXCLUDED.lease_epoch, publish_records.lease_epoch),
                           updated_at = now()
         WHERE publish_records.resource_key = EXCLUDED.resource_key
           AND publish_records.status = 'pending' AND publish_records.github_id IS NULL
           AND publish_records.detail ? 'selectedOwnVerdict'
           AND publish_records.detail->>'status' IS DISTINCT FROM 'starting'
           AND (EXCLUDED.lease_epoch IS NULL OR EXISTS (
             SELECT 1 FROM pr_actor_leases WHERE work_item_id = EXCLUDED.work_item_id
               AND lease_epoch = EXCLUDED.lease_epoch
           ))`,
        [
          crypto.randomUUID(),
          params.workItemId,
          params.resourceKey,
          params.reviewLens,
          params.leaseEpoch ?? null,
          JSON.stringify(params.detail ?? {}),
        ],
      ),
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
    leaseEpoch?: number | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await fencedWrite(
    pool,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      pool.query(
        `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, lease_epoch, detail)
         SELECT $1, $2, $3, $4, 'check_run', $5, 'completed', $6, $7::jsonb
          WHERE $6::bigint IS NULL OR EXISTS (
            SELECT 1 FROM pr_actor_leases
             WHERE work_item_id = $2 AND lease_epoch = $6
          )
			 ON CONFLICT (work_item_id, review_lens, step) WHERE step = 'check_run'
			 DO UPDATE SET resource_key = EXCLUDED.resource_key,
			               github_id = EXCLUDED.github_id,
			               status = 'completed',
			               lease_epoch = COALESCE(EXCLUDED.lease_epoch, publish_records.lease_epoch),
               detail = publish_records.detail || EXCLUDED.detail,
               updated_at = now()
         WHERE EXCLUDED.lease_epoch IS NULL OR EXISTS (
           SELECT 1 FROM pr_actor_leases
            WHERE work_item_id = EXCLUDED.work_item_id
              AND lease_epoch = EXCLUDED.lease_epoch
         )`,
        [
          crypto.randomUUID(),
          params.workItemId,
          params.resourceKey,
          params.reviewLens,
          String(params.githubId),
          params.leaseEpoch ?? null,
          JSON.stringify(params.detail ?? {}),
        ],
      ),
  );
}

export async function releaseUnstartedReviewCheckRunReservation(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: AnyReviewLens;
    leaseEpoch?: number | null;
    staleBefore?: Date;
  },
): Promise<boolean> {
  const values: unknown[] = [params.workItemId, params.resourceKey, params.reviewLens];
  const leaseParam =
    params.leaseEpoch == null ? null : (values.push(params.leaseEpoch), values.length);
  const staleParam =
    params.staleBefore == null ? null : (values.push(params.staleBefore), values.length);
  const staleClause = staleParam == null ? "" : `AND updated_at < $${staleParam}`;
  const leaseClause =
    leaseParam == null
      ? ""
      : `AND EXISTS (
           SELECT 1 FROM pr_actor_leases
            WHERE work_item_id = $1 AND lease_epoch = $${leaseParam}
         )
         AND (
           lease_epoch = $${leaseParam}
           ${staleParam == null ? "" : `OR updated_at < $${staleParam}`}
         )`;
  const eligibilityClause = leaseParam == null ? staleClause : leaseClause;
  const result = await fencedWrite(
    pool,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      pool.query(
        `WITH protected AS (
       UPDATE publish_records
          SET detail = detail - 'status' - 'headSha' - 'name' - 'externalId' - 'recoveredStaleReservation',
              updated_at = now()
        WHERE work_item_id = $1 AND resource_key = $2 AND review_lens = $3 AND step = 'check_run'
          AND status = 'pending' AND github_id IS NULL
          AND detail ? 'selectedOwnVerdict' AND detail->>'status' = 'starting'
          ${eligibilityClause}
        RETURNING id
     ), ordinary AS (
       DELETE FROM publish_records
		  WHERE work_item_id = $1
		    AND resource_key = $2
		    AND review_lens = $3
		    AND step = 'check_run'
		    AND status = 'pending'
		    AND github_id IS NULL
        AND NOT (detail ? 'selectedOwnVerdict')
    ${eligibilityClause}
       RETURNING id
     ) SELECT id FROM protected UNION ALL SELECT id FROM ordinary`,
        values,
      ),
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

function parseStoredPlacement(value: unknown): StoredInlineBatchRef["placements"][number] | null {
  if (!isRecord(value)) return null;
  const finding = v.safeParse(reviewFindingSchema, value.finding);
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
    finding: finding.output,
    resolvedLine,
    canonicalFingerprint: value.canonicalFingerprint,
  };
}

export function parseStoredInlineBatches(detail: Record<string, unknown>): StoredInlineBatchRef[] {
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
  progressCommentGithubId: number | null;
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
  const currentPublish = row?.current_publish ?? [];
  const shouldLinkToSummary = row?.prior_summary_exists ?? false;
  const progressCommentGithubId =
    row?.latest_progress_comment_github_id != null
      ? Number(row.latest_progress_comment_github_id)
      : null;
  return {
    publishState: parseReviewPublishStateRows(currentPublish, workItemId),
    shouldLinkToSummary,
    storedInlineFingerprints: mergeStoredInlineFingerprints(row?.fingerprint_details ?? []),
    resumedPlacements: parseResumedPlacements(currentPublish, workItemId),
    progressCommentGithubId:
      progressCommentGithubId != null && Number.isFinite(progressCommentGithubId)
        ? progressCommentGithubId
        : null,
  };
}
