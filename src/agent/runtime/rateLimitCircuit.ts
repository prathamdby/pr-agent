import type { Pool } from "pg";
import { logInfo, logWarn } from "../../evlog.js";
import {
  createRateLimitCircuit,
  type RateLimitCircuit,
  type RateLimitFailureClass,
} from "../../github/rateLimitCircuit.js";
import {
  getSharedRateLimitCircuit,
  openSharedRateLimitCircuitBestEffort,
} from "../../github/sharedRateLimitCircuit.js";
import { errorMessage } from "../../errors/errorMessage.js";

/**
 * Per-run GitHub rate-limit circuit shared by ask and review. A tripped circuit is
 * published to the installation row; a run that starts inside an open window
 * hydrates from it. The shared read is best-effort: a database blip must not
 * abort the run.
 */
export async function openRunRateLimitCircuit(params: {
  readonly pool: Pool | undefined;
  readonly installationId: number;
  readonly type: "ask" | "review";
  readonly workItemId?: string;
  readonly onOpened?: (kind: RateLimitFailureClass) => void;
}): Promise<RateLimitCircuit> {
  const { pool, installationId, type } = params;
  const logIdentity = {
    installationId,
    type,
    ...(params.workItemId != null ? { workItemId: params.workItemId } : {}),
  };
  const circuit = createRateLimitCircuit({
    installationId,
    onOpened: (kind) => {
      params.onOpened?.(kind);
      openSharedRateLimitCircuitBestEffort(pool, { installationId, lastErrorKind: kind });
    },
  });
  if (pool == null || installationId <= 0) return circuit;
  try {
    const shared = await getSharedRateLimitCircuit(pool, installationId);
    if (shared != null && shared.openUntil.getTime() > Date.now()) {
      circuit.hydrateOpenFromShared(
        shared.lastErrorKind === "secondary" ? "secondary" : "primary",
        shared.openUntil,
      );
      logInfo("github_shared_rate_limit_circuit_honored", logIdentity);
    }
  } catch (error) {
    logWarn("github_shared_rate_limit_circuit_read_failed", {
      ...logIdentity,
      message: errorMessage(error),
    });
  }
  return circuit;
}
