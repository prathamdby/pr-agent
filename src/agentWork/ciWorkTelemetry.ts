import type { Pool } from "pg";
import type { CiWorkTelemetry } from "../analytics/workCompleted.ts";
import { parseCiAuthoredCache, isCheckFactFailing } from "../review/ci/ciFacts.ts";
import { loadPrHeadCiState, type PrHeadCiStateRow } from "./prHeadCiState.ts";

export function ciWorkTelemetryFromRow(row: PrHeadCiStateRow | null): CiWorkTelemetry {
  if (row == null) {
    return { rollup: "none", failingCount: 0, authored: false };
  }
  return {
    rollup: row.rollup,
    failingCount: Object.values(row.checks).filter(isCheckFactFailing).length,
    authored: parseCiAuthoredCache(row.authored) != null,
    ...(row.rollup === "unknown" ? { unavailableReason: "incomplete" } : {}),
  };
}

export async function loadCiWorkTelemetry(
  pool: Pool,
  owner: string,
  repo: string,
  headSha: string,
): Promise<CiWorkTelemetry> {
  try {
    const row = await loadPrHeadCiState(pool, owner, repo, headSha);
    return ciWorkTelemetryFromRow(row);
  } catch {
    return { rollup: "none", failingCount: 0, authored: false };
  }
}
