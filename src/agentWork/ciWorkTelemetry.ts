import type { DatabaseSync } from "node:sqlite";
import { loadHeadCiProjectionRow } from "../state/prHeadCiState.ts";
import type { CiWorkTelemetry } from "../analytics/workCompleted.ts";
import { parseCiAuthoredCache, isCheckFactFailing } from "../review/ci/ciFacts.ts";
import type { PrHeadCiStateRow } from "./prHeadCiState.ts";

export function ciWorkTelemetryFromRow(
  row: Pick<PrHeadCiStateRow, "rollup" | "checks" | "authored"> | null,
) {
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

export function loadCiWorkTelemetryFromState(
  db: DatabaseSync,
  owner: string,
  repo: string,
  headSha: string,
) {
  try {
    return ((pinnedReturn: CiWorkTelemetry) => pinnedReturn)(
      ciWorkTelemetryFromRow(loadHeadCiProjectionRow(db, { owner, repo, headSha })),
    );
  } catch {
    return ((pinnedReturn: CiWorkTelemetry) => pinnedReturn)({
      rollup: "none",
      failingCount: 0,
      authored: false,
    });
  }
}
