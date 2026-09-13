import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import {
  ciSummaryFromFacts,
  waitingCiSummary,
  type RenderableHeadCi,
} from "../review/ci/ciFromHeadState.js";
import { enqueueCiProjectionDebouncedStandalone } from "./intake/queueing.js";
import { loadPrHeadCiState } from "./prHeadCiState.js";
import type { CiProjectionJobData } from "./types.js";

export async function loadRenderableHeadCi(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
): Promise<RenderableHeadCi> {
  const row = await loadPrHeadCiState(pool, owner, repo, headSha);
  if (row == null) return waitingCiSummary(0);
  return ciSummaryFromFacts(row.checks, row.version, row.authored);
}

export async function enqueueCiProjectionIfVersionMoved(params: {
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
  if (row == null || row.version <= params.renderedVersion) return;
  const job: CiProjectionJobData = {
    kind: "ci_projection",
    installationId: params.installationId,
    owner: params.owner,
    repo: params.repo,
    headSha: params.headSha,
  };
  await enqueueCiProjectionDebouncedStandalone(params.boss, job);
}
