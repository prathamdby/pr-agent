import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logDebug, logWarn } from "../evlog.js";
import { CI_PROJECTION_REPAIR_BATCH_SIZE } from "../settings/index.js";
import { requestHeadCiProjection } from "./ciProjection.js";
import { clearProjectionRepairPending, listProjectionRepairPendingHeads } from "./prHeadCiState.js";

export type ProjectionRepairScanReport = {
  readonly pendingScanned: number;
  readonly enqueued: number;
  readonly unreachable: number;
  readonly skippedNoInstallation: number;
};

/**
 * Bounded diagnostics tick: enqueue ordinary projection jobs for heads still
 * flagged for one-time legacy marker repair. Does not touch GitHub or comment bodies.
 */
export async function scanProjectionRepairPending(params: {
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly limit?: number;
}): Promise<ProjectionRepairScanReport> {
  const limit = params.limit ?? CI_PROJECTION_REPAIR_BATCH_SIZE;
  const pending = await listProjectionRepairPendingHeads(params.pool, limit);
  let enqueued = 0;
  let unreachable = 0;
  let skippedNoInstallation = 0;

  for (const candidate of pending) {
    if (candidate.installationId == null) {
      skippedNoInstallation += 1;
      logWarn("ci_projection_repair_unreachable", {
        owner: candidate.owner,
        repo: candidate.repo,
        headSha: candidate.headSha,
        reason: "no_associated_work",
      });
      await clearProjectionRepairPending(
        params.pool,
        candidate.owner,
        candidate.repo,
        candidate.headSha,
      );
      unreachable += 1;
      continue;
    }

    const result = await requestHeadCiProjection(
      params.boss,
      {
        installationId: candidate.installationId,
        owner: candidate.owner,
        repo: candidate.repo,
        headSha: candidate.headSha,
      },
      { kind: "debounced" },
    );
    if (result === "enqueued") enqueued += 1;
    logDebug("ci_projection_repair_enqueued", {
      owner: candidate.owner,
      repo: candidate.repo,
      headSha: candidate.headSha,
      result,
    });
  }

  return {
    pendingScanned: pending.length,
    enqueued,
    unreachable,
    skippedNoInstallation,
  };
}
