import type { Pool } from "pg";
import type { CiWorkTelemetry } from "../analytics/workCompleted.ts";
import { parseCiAuthoredCache, isCheckFactFailing } from "../review/ci/ciFacts.ts";
import { loadPrHeadCiState, type PrHeadCiStateRow } from "./prHeadCiState.ts";

export function ciWorkTelemetryFromRow(row: PrHeadCiStateRow | null) {
  if (row == null) {
    return ((pinnedReturn: CiWorkTelemetry) => pinnedReturn)({
      rollup: "none",
      failingCount: 0,
      authored: false,
    });
  }
  return ((pinnedReturn: CiWorkTelemetry) => pinnedReturn)({
    rollup: row.rollup,
    failingCount: Object.values(row.checks).filter(isCheckFactFailing).length,
    authored: parseCiAuthoredCache(row.authored) != null,
    ...(row.rollup === "unknown" ? { unavailableReason: "incomplete" } : {}),
  });
}

export async function loadCiWorkTelemetry(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
) {
  try {
    const row = await loadPrHeadCiState(pool, owner, repo, headSha);
    return ((pinnedReturn: CiWorkTelemetry | Promise<CiWorkTelemetry>) => pinnedReturn)(
      ciWorkTelemetryFromRow(row),
    );
  } catch {
    return ((pinnedReturn: CiWorkTelemetry | Promise<CiWorkTelemetry>) => pinnedReturn)({
      rollup: "none",
      failingCount: 0,
      authored: false,
    });
  }
}
