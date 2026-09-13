import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  ciSummaryFromFacts,
  headCiFactsAreComplete,
  waitingCiSummary,
  type RenderableHeadCi,
} from "../review/ci/ciFromHeadState.js";
import { AUTOMATED_PR_ACTIONS, DEFERRED_HEAD_SHA } from "../settings/index.js";
import { enqueueCiProjectionDebouncedStandalone } from "./intake/queueing.js";
import { headCiNeedsSeed, loadPrHeadCiState, type PrHeadCiStateRow } from "./prHeadCiState.js";
import type { CiProjectionJobData } from "./types.js";

export async function loadRenderableHeadCi(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
): Promise<RenderableHeadCi> {
  const row = await loadPrHeadCiState(pool, owner, repo, headSha);
  if (row == null) return waitingCiSummary(0);
  return ciSummaryFromFacts(row.checks, row.version, row.authored, {
    checkRunsComplete: headCiFactsAreComplete(row.rollup),
  });
}

function isHeadCiSeedPullRequestAction(action: string): boolean {
  return action !== "closed" && AUTOMATED_PR_ACTIONS.has(action);
}

/** True when this pull_request delivery should schedule the first head seed. */
export function shouldSeedHeadCiFromPullRequest(
  action: string,
  headSha: string,
  row: Pick<PrHeadCiStateRow, "seededAt"> | null,
): boolean {
  return (
    isHeadCiSeedPullRequestAction(action) && headSha !== DEFERRED_HEAD_SHA && headCiNeedsSeed(row)
  );
}

/** True when a claim-time writer should enqueue after stamping the cell. */
export function ciProjectionDue(
  row: Pick<PrHeadCiStateRow, "seededAt" | "version"> | null,
  renderedVersion: number,
): boolean {
  if (headCiNeedsSeed(row)) return true;
  return row != null && row.version > renderedVersion;
}

export async function enqueueCiProjectionIfDue(params: {
  readonly boss: PgBoss | undefined;
  readonly pool: Pool;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly renderedVersion: number;
}): Promise<void> {
  if (params.boss == null || params.installationId <= 0) return;
  const row = await loadPrHeadCiState(params.pool, params.owner, params.repo, params.headSha);
  if (!ciProjectionDue(row, params.renderedVersion)) return;
  const job: CiProjectionJobData = {
    kind: "ci_projection",
    installationId: params.installationId,
    owner: params.owner,
    repo: params.repo,
    headSha: params.headSha,
  };
  await enqueueCiProjectionDebouncedStandalone(params.boss, job);
}
