import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ReviewMode } from "../review/reviewSchema.js";
import type { AutoFixTarget, PersistAutoFixTargetInput, AutoFixPlacementKind } from "./types.js";

type AutoFixTargetRow = {
  id: string;
  bundle_id: string;
  work_item_id: string;
  resource_key: string;
  review_lens: ReviewMode;
  head_sha: string;
  fingerprint: string;
  severity: "P0" | "P1" | "P2";
  file_path: string;
  start_line: number;
  end_line: number;
  title: string;
  detail: string;
  fix_prompt: string;
  placement_kind: AutoFixPlacementKind;
  inline_review_comment_id: string | number | null;
};

function mapTarget(row: AutoFixTargetRow): AutoFixTarget {
  const inlineId =
    row.inline_review_comment_id == null ? null : Number(row.inline_review_comment_id);
  return {
    id: row.id,
    bundleId: row.bundle_id,
    workItemId: row.work_item_id,
    resourceKey: row.resource_key,
    reviewLens: row.review_lens,
    headSha: row.head_sha,
    fingerprint: row.fingerprint,
    severity: row.severity,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    title: row.title,
    detail: row.detail,
    fixPrompt: row.fix_prompt,
    placementKind: row.placement_kind,
    inlineReviewCommentId: inlineId == null || !Number.isFinite(inlineId) ? null : inlineId,
  };
}

export async function recordAutoFixBundle(
  pool: Pool,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: ReviewMode;
    headSha: string;
    targets: readonly PersistAutoFixTargetInput[];
  },
): Promise<string | null> {
  if (params.targets.length === 0) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bundleId = crypto.randomUUID();
    await client.query(
      `INSERT INTO auto_fix_bundles (id, work_item_id, resource_key, review_lens, head_sha)
       VALUES ($1, $2, $3, $4, $5)`,
      [bundleId, params.workItemId, params.resourceKey, params.reviewLens, params.headSha],
    );
    for (const target of params.targets) {
      const finding = target.finding;
      await client.query(
        `INSERT INTO auto_fix_targets (
           id, bundle_id, work_item_id, resource_key, review_lens, head_sha,
           fingerprint, severity, file_path, start_line, end_line, title, detail,
           fix_prompt, placement_kind, inline_review_comment_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          crypto.randomUUID(),
          bundleId,
          params.workItemId,
          params.resourceKey,
          params.reviewLens,
          params.headSha,
          target.fingerprint,
          finding.severity,
          finding.file,
          finding.startLine,
          finding.endLine,
          finding.title,
          finding.detail,
          finding.fixPrompt ?? "",
          target.placementKind,
          target.inlineReviewCommentId ?? null,
        ],
      );
    }
    await client.query("COMMIT");
    return bundleId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function selectTargets(client: Pool | PoolClient, sql: string, values: unknown[]) {
  const { rows } = await client.query<AutoFixTargetRow>(sql, values);
  return rows.map(mapTarget);
}

export async function findAutoFixTargetByInlineComment(
  client: Pool | PoolClient,
  params: {
    resourceKey: string;
    inlineReviewCommentId: number;
  },
): Promise<AutoFixTarget | null> {
  const targets = await selectTargets(
    client,
    `SELECT t.id, t.bundle_id, t.work_item_id, t.resource_key, t.review_lens, t.head_sha,
            t.fingerprint, t.severity, t.file_path, t.start_line, t.end_line, t.title,
            t.detail, t.fix_prompt, t.placement_kind, t.inline_review_comment_id
       FROM auto_fix_targets t
       JOIN auto_fix_bundles b ON b.id = t.bundle_id
      WHERE t.resource_key = $1
        AND t.inline_review_comment_id = $2
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [params.resourceKey, params.inlineReviewCommentId],
  );
  return targets[0] ?? null;
}

export async function findLatestAutoFixTargetsByLens(
  client: Pool | PoolClient,
  params: {
    resourceKey: string;
    lenses: readonly ReviewMode[];
  },
): Promise<AutoFixTarget[]> {
  if (params.lenses.length === 0) return [];
  return selectTargets(
    client,
    `WITH latest AS (
       SELECT DISTINCT ON (review_lens) id
         FROM auto_fix_bundles
        WHERE resource_key = $1
          AND review_lens = ANY($2::text[])
          AND EXISTS (
            SELECT 1
              FROM auto_fix_targets t
             WHERE t.bundle_id = auto_fix_bundles.id
          )
        ORDER BY review_lens, created_at DESC
     )
     SELECT t.id, t.bundle_id, t.work_item_id, t.resource_key, t.review_lens, t.head_sha,
            t.fingerprint, t.severity, t.file_path, t.start_line, t.end_line, t.title,
            t.detail, t.fix_prompt, t.placement_kind, t.inline_review_comment_id
       FROM auto_fix_targets t
       JOIN latest ON latest.id = t.bundle_id
      ORDER BY t.file_path ASC, t.start_line ASC, t.end_line ASC, t.severity ASC`,
    [params.resourceKey, params.lenses],
  );
}
