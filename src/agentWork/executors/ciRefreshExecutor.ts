import type { Config } from "../../config.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logDebug } from "../../evlog.js";
import { enqueueCiProjectionDebouncedStandalone } from "../intake/queueing.js";
import type { CiProjectionJobData, CiRefreshJobData } from "../types.js";

/**
 * One-release shim. Old web still sends `agent-work-ci-refresh`.
 * Enqueue a projection for the job head and exit. Deleted in Phase 10.
 */
export async function executeCiRefreshJob(
  _cfg: Config,
  _pool: Pool,
  boss: PgBoss,
  data: CiRefreshJobData,
): Promise<void> {
  const job: CiProjectionJobData = {
    kind: "ci_projection",
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
    webhookEventId: data.webhookEventId,
    delivery: data.delivery,
  };
  const result = await enqueueCiProjectionDebouncedStandalone(boss, job);
  logDebug("ci_refresh_shim_enqueued_projection", {
    owner: data.owner,
    repo: data.repo,
    pr: data.prNumber,
    headSha: data.headSha,
    result,
  });
}
