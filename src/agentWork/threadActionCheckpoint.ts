import type { Pool } from "pg";
import { TRIAGE_PUBLISH_LENS, VERIFICATION_PUBLISH_LENS } from "../settings/index.js";
import { recordPublishStep } from "./repository.js";

export type ThreadActionPublishLens = typeof TRIAGE_PUBLISH_LENS | typeof VERIFICATION_PUBLISH_LENS;

export type ThreadActionPublishStep = "triage_thread_actions" | "verification_thread_actions";

export function actedThreadIdsFromDetail(detail: unknown): number[] {
  if (!detail || typeof detail !== "object" || !("actedThreadIds" in detail)) return [];
  const value = detail.actedThreadIds;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => Number.isInteger(item));
}

export async function loadActedThreadIds(
  pool: Pool,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: ThreadActionPublishLens;
    readonly step: ThreadActionPublishStep;
  },
): Promise<number[]> {
  const row = await pool.query<{ detail: unknown }>(
    `SELECT detail
       FROM publish_records
      WHERE work_item_id = $1
        AND resource_key = $2
        AND review_lens = $3
        AND step = $4
        AND status = 'completed'
      LIMIT 1`,
    [params.workItemId, params.resourceKey, params.reviewLens, params.step],
  );
  return actedThreadIdsFromDetail(row.rows[0]?.detail);
}

export async function recordActedThreadIds(
  pool: Pool,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: ThreadActionPublishLens;
    readonly step: ThreadActionPublishStep;
    readonly actedThreadIds: readonly number[];
  },
): Promise<void> {
  await recordPublishStep(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    step: params.step,
    detail: { actedThreadIds: params.actedThreadIds },
  });
}
