import type { Pool } from "pg";
import { logInfo, logWarn } from "../../evlog.ts";
import {
  createRateLimitCircuit,
  type RateLimitCircuit,
  type RateLimitFailureClass,
} from "../../github/rateLimitCircuit.ts";
import {
  getSharedRateLimitCircuit,
  openSharedRateLimitCircuitBestEffort,
} from "../../github/sharedRateLimitCircuit.ts";
import { errorMessage } from "../../errors/errorMessage.ts";

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
