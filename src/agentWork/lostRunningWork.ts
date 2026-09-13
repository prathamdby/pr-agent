import type { Pool } from "pg";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import { createPrSurface } from "../github/prSurface.js";
import { mintInstallationToken } from "../github/installationToken.js";
import { DEFERRED_HEAD_SHA, STALE_QUEUED_WORK_BATCH_SIZE } from "../settings/index.js";
import { isAnyReviewLens } from "../settings/legacyReviewLenses.js";
import { closeOwnVerdict } from "./closeOwnVerdict.js";
import {
  asTerminalOwnCheckStatus,
  isOwnCheckOpen,
  resolveOwnVerdictForTerminalReview,
  type TerminalOwnCheckStatus,
} from "./ownCheckReconcile.js";
import { getCompletedPublishStepDetail, getWorkItemCore, markWorkFailed } from "./repository.js";
import type { LostRunningWorkItem } from "./workerHealth.js";

export async function listTerminalReviewsWithOpenOwnChecks(
  pool: Pool,
  limit = STALE_QUEUED_WORK_BATCH_SIZE,
): Promise<readonly LostRunningWorkItem[]> {
  const result = await pool.query<{
    id: string;
    resource_key: string;
    work_type: string;
  }>(
    `SELECT w.id::text AS id,
            w.resource_key,
            w.type AS work_type
       FROM agent_work_items w
       JOIN publish_records p
         ON p.work_item_id = w.id
        AND p.step = 'check_run'
        AND p.status = 'completed'
      WHERE w.type = 'review'
        AND w.status IN ('completed', 'failed', 'cancelled', 'superseded')
        AND (
          COALESCE(p.detail->>'status', '') = 'in_progress'
          OR COALESCE(p.detail->>'conclusion', '') = ''
        )
      ORDER BY w.updated_at ASC
      LIMIT $1::int`,
    [limit],
  );
  return result.rows.map((row) => ({
    workItemId: row.id,
    resourceKey: row.resource_key,
    workType: row.work_type,
    ageSeconds: null,
  }));
}

async function closeOpenOwnVerdict(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly workItemId: string;
  readonly status: TerminalOwnCheckStatus;
}): Promise<void> {
  const core = await getWorkItemCore(params.pool, params.workItemId);
  if (core == null) return;
  if (core.type !== "review" || core.reviewLens == null || !isAnyReviewLens(core.reviewLens)) {
    return;
  }
  if (core.headSha === DEFERRED_HEAD_SHA) return;
  const checkDetail = await getCompletedPublishStepDetail(
    params.pool,
    core.id,
    core.resourceKey,
    core.reviewLens,
    "check_run",
  );
  if (!isOwnCheckOpen(checkDetail)) return;
  const installation = await mintInstallationToken(params.cfg, core.installationId);
  const prSurface = createPrSurface({
    cfg: params.cfg,
    installationId: core.installationId,
    owner: core.owner,
    repo: core.repo,
    prNumber: core.prNumber,
    installation,
  });
  await closeOwnVerdict({
    pool: params.pool,
    prSurface,
    owner: core.owner,
    repo: core.repo,
    prNumber: core.prNumber,
    workItemId: core.id,
    resourceKey: core.resourceKey,
    reviewLens: core.reviewLens,
    headSha: core.headSha,
    leaseEpoch: null,
    commitStatusEnabled: params.cfg.features.commitStatus,
    outcome: await resolveOwnVerdictForTerminalReview({
      pool: params.pool,
      workItemId: core.id,
      resourceKey: core.resourceKey,
      reviewLens: core.reviewLens,
      status: params.status,
    }),
  });
}

/** Mark lost running items failed, then close any review whose check is still open. */
export async function reconcileLostRunningWork(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly items: readonly LostRunningWorkItem[];
}): Promise<void> {
  const seen = new Set<string>();
  for (const item of params.items) {
    seen.add(item.workItemId);
    try {
      const core = await getWorkItemCore(params.pool, item.workItemId);
      if (core == null) continue;
      if (core.status === "running") {
        const marked = await markWorkFailed(
          params.pool,
          item.workItemId,
          new Error("worker_lost"),
          null,
        );
        if (!marked) continue;
      } else if (core.status !== "failed") {
        continue;
      }
      if (core.type !== "review") continue;
      await closeOpenOwnVerdict({
        cfg: params.cfg,
        pool: params.pool,
        workItemId: item.workItemId,
        status: "failed",
      });
    } catch (error) {
      logWarn("lost_running_work_reconcile_failed", {
        workItemId: item.workItemId,
        resourceKey: item.resourceKey,
        workType: item.workType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let extra: readonly LostRunningWorkItem[] = [];
  try {
    extra = await listTerminalReviewsWithOpenOwnChecks(params.pool);
  } catch (error) {
    logWarn("lost_running_work_open_check_list_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const item of extra) {
    if (seen.has(item.workItemId)) continue;
    try {
      const core = await getWorkItemCore(params.pool, item.workItemId);
      const status = core == null ? null : asTerminalOwnCheckStatus(core.status);
      if (status == null) continue;
      await closeOpenOwnVerdict({
        cfg: params.cfg,
        pool: params.pool,
        workItemId: item.workItemId,
        status,
      });
    } catch (error) {
      logWarn("lost_running_work_reconcile_failed", {
        workItemId: item.workItemId,
        resourceKey: item.resourceKey,
        workType: item.workType,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
