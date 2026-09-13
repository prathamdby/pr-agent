import type { Pool } from "pg";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import { createPrSurface } from "../github/prSurface.js";
import { mintInstallationToken } from "../github/installationToken.js";
import { DEFERRED_HEAD_SHA } from "../settings/index.js";
import { isAnyReviewLens } from "../settings/legacyReviewLenses.js";
import { closeOwnVerdict } from "./closeOwnVerdict.js";
import { getWorkItemCore, markWorkFailed } from "./repository.js";
import type { LostRunningWorkItem } from "./workerHealth.js";

/** Mark lost running items failed, then close the review verdict when one exists. */
export async function reconcileLostRunningWork(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly items: readonly LostRunningWorkItem[];
}): Promise<void> {
  for (const item of params.items) {
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
      if (core.type !== "review" || core.reviewLens == null || !isAnyReviewLens(core.reviewLens)) {
        continue;
      }
      if (core.headSha === DEFERRED_HEAD_SHA) continue;
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
        outcome: { kind: "crashed" },
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
