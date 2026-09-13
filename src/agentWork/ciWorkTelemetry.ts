import type { Pool } from "pg";
import {
  captureDurableWorkCompleted,
  type CiWorkTelemetry,
  type DegradedReason,
  type WorkCompletedOutcome,
} from "../analytics/workCompleted.js";
import { parseCiAuthoredCache } from "../review/ci/ciAuthoredCache.js";
import { isCheckFactFailing } from "../review/ci/classifySnapshot.js";
import { loadPrHeadCiState, type PrHeadCiStateRow } from "./prHeadCiState.js";

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

export async function captureDurableWorkCompletedWithCi(
  pool: Pool,
  input: Parameters<typeof captureDurableWorkCompleted>[0],
): Promise<void> {
  const ci = await loadCiWorkTelemetry(pool, input.item.owner, input.item.repo, input.item.headSha);
  if (
    input.workType === "review" &&
    input.outcome === "published" &&
    ci.unavailableReason != null
  ) {
    const degradedReason: DegradedReason = "ci_unavailable";
    const outcome: WorkCompletedOutcome = "degraded";
    captureDurableWorkCompleted({
      ...input,
      outcome,
      degradedReason,
      ci,
    });
    return;
  }
  captureDurableWorkCompleted({ ...input, ci });
}
