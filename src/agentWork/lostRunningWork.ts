import { productionInstallationSurface } from "./installationSurface.js";
import { createPublishContext } from "./publishOnce.js";
import type { Pool } from "pg";
import {
  type Config,
  DEFERRED_HEAD_SHA,
  STALE_QUEUED_WORK_BATCH_SIZE,
  STALE_QUEUED_WORK_GRACE_SECONDS,
  isAnyReviewLens,
} from "../settings/index.js";
import { logWarn } from "../evlog.js";
import { reviewVerdict, asTerminalOwnCheckStatus, isOwnCheckOpen } from "./reviewVerdict.js";
import { getWorkItemCore, markLostRunningWorkFailed } from "./workItemStateRepository.js";
import type { LostRunningWorkItem } from "./workerHealth.js";
import { errorMessage } from "../errors/errorMessage.js";
import {
  loadGithubCapabilityObservation,
  recordGithubCapabilityDenial,
} from "./githubCapabilityRepository.js";
import {
  getOwnVerdictCloseRecord,
  ownVerdictStatusApplicable,
  hasOwnVerdictSurfaceAcceptance,
} from "./publishRecordRepository.js";
import {
  availableInstallationCapabilities,
  unknownInstallationCapabilities,
  createReviewCapabilityPolicy,
} from "../github/installationCapabilities.js";

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
       LEFT JOIN publish_records p
         ON p.work_item_id = w.id
        AND p.step = 'check_run'
       LEFT JOIN github_repository_capabilities g
         ON g.installation_id = w.installation_id
        AND g.owner = w.owner
        AND g.repo = w.repo
      CROSS JOIN LATERAL (
        -- Blocked candidates would refill the bounded batch. As in closeOpenOwnVerdict,
        -- no saved record allows repair and a missing key is unknown.
        SELECT g.installation_id IS NULL OR g.capabilities->>'checksWrite' = 'available' AS checks,
               g.installation_id IS NULL OR g.capabilities->>'statusesWrite' = 'available' AS statuses
      ) writable
      WHERE w.type = 'review'
        AND w.status IN ('completed', 'failed', 'cancelled', 'superseded')
        AND (
          (p.detail ? 'selectedOwnVerdict' AND (
            (writable.checks
              AND COALESCE(p.detail->>'ownCheckApplied', '') <> 'true'
              AND COALESCE(p.detail->>'ownCheckState', '') <> 'skipped-for-this-run')
            OR (writable.statuses
              AND p.detail->'selectedOwnVerdict'->'status'->>'enabled' = 'true'
              AND COALESCE(p.detail->'selectedOwnVerdict'->'status'->>'headSha', '')
                  NOT IN ('', 'deferred-to-worker')
              AND COALESCE(p.detail->>'ownStatusApplied', '') <> 'true'
              AND COALESCE(p.detail->>'ownStatusState', '') <> 'skipped-for-this-run')
          ))
          OR (NOT (p.detail ? 'selectedOwnVerdict') AND p.status = 'completed'
            AND (writable.checks OR writable.statuses) AND (
            COALESCE(p.detail->>'status', '') = 'in_progress'
            OR COALESCE(p.detail->>'conclusion', '') = ''
          ))
          OR (p.id IS NULL AND (writable.checks OR writable.statuses) AND EXISTS (
            SELECT 1 FROM operation_intents i WHERE i.work_item_id = w.id
              AND i.mutation_kind = 'github.review_commit_status'
              AND (i.detail->>'state' = 'pending'
                   OR i.operation_key LIKE 'review:commit_status:%:pending')
              AND (i.status IN ('reconciled', 'outcome_unknown') OR i.detail ? '__result'
                   OR (i.status <> 'failed' AND i.detail->'__mutating' = 'true'::jsonb))
          ))
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
}): Promise<void> {
  const core = await getWorkItemCore(params.pool, params.workItemId);
  if (core == null || asTerminalOwnCheckStatus(core.status) == null) return;
  if (core.type !== "review" || core.reviewLens == null || !isAnyReviewLens(core.reviewLens)) {
    return;
  }
  if (core.headSha === DEFERRED_HEAD_SHA) return;
  const identity = {
    workItemId: core.id,
    resourceKey: core.resourceKey,
    reviewLens: core.reviewLens,
  };
  const record = await getOwnVerdictCloseRecord(params.pool, identity);
  const checkDetail = await createPublishContext(params.pool, {
    workItemId: core.id,
    resourceKey: core.resourceKey,
    reviewLens: core.reviewLens,
  }).completed("check_run");
  if (record?.legacyClosed || (record?.selected == null && !isOwnCheckOpen(checkDetail))) return;
  const saved = await loadGithubCapabilityObservation(params.pool, core);
  const available = availableInstallationCapabilities({
    appId: params.cfg.github.appId,
    installationId: core.installationId,
    owner: core.owner,
    repo: core.repo,
  });
  const unknown = unknownInstallationCapabilities(available.scope, String(saved?.generation ?? 0));
  const capabilities = createReviewCapabilityPolicy(
    saved == null
      ? available
      : {
          ...available,
          generation: String(saved.generation),
          availability: { ...unknown.availability, ...saved.capabilities },
        },
    saved == null
      ? undefined
      : async (operation) => {
          await recordGithubCapabilityDenial(params.pool, {
            installationId: core.installationId,
            owner: core.owner,
            repo: core.repo,
            generation: saved.generation,
            operation,
          });
        },
  );
  const checkNeedsRepair = !record?.checkApplied && record?.checkState !== "skipped-for-this-run";
  const statusNeedsRepair =
    record?.selected == null
      ? params.cfg.features.commitStatus ||
        (await hasOwnVerdictSurfaceAcceptance(params.pool, identity, "status"))
      : ownVerdictStatusApplicable(record.selected) &&
        !record.statusApplied &&
        record.statusState !== "skipped-for-this-run";
  if (
    (!checkNeedsRepair || capabilities.access("checksWrite") !== "available") &&
    (!statusNeedsRepair || capabilities.access("statusesWrite") !== "available")
  )
    return;
  const installation = await productionInstallationSurface.token(params.cfg, core.installationId);
  const prSurface = await productionInstallationSurface.create({
    cfg: params.cfg,
    installationId: core.installationId,
    owner: core.owner,
    repo: core.repo,
    prNumber: core.prNumber,
    installation,
    capabilities,
  });
  await reviewVerdict({
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
    summaryCommentId: null,
  }).repairIfOpen();
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
      if (core == null || core.status !== "running") continue;
      const marked = await markLostRunningWorkFailed(
        params.pool,
        item.workItemId,
        params.cfg.queue.prActorLeaseTtlSeconds + STALE_QUEUED_WORK_GRACE_SECONDS,
      );
      if (!marked) continue;
      if (core.type !== "review") continue;
      await closeOpenOwnVerdict({
        cfg: params.cfg,
        pool: params.pool,
        workItemId: item.workItemId,
      });
    } catch (error) {
      logWarn("lost_running_work_reconcile_failed", {
        workItemId: item.workItemId,
        resourceKey: item.resourceKey,
        workType: item.workType,
        message: errorMessage(error),
      });
    }
  }

  let extra: readonly LostRunningWorkItem[] = [];
  try {
    extra = await listTerminalReviewsWithOpenOwnChecks(params.pool);
  } catch (error) {
    logWarn("lost_running_work_open_check_list_failed", {
      message: errorMessage(error),
    });
    return;
  }

  for (const item of extra) {
    if (seen.has(item.workItemId)) continue;
    try {
      await closeOpenOwnVerdict({
        cfg: params.cfg,
        pool: params.pool,
        workItemId: item.workItemId,
      });
    } catch (error) {
      logWarn("lost_running_work_reconcile_failed", {
        workItemId: item.workItemId,
        resourceKey: item.resourceKey,
        workType: item.workType,
        message: errorMessage(error),
      });
    }
  }
}
