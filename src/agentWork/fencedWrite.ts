import type { Pool, PoolClient } from "pg";
import { assertPrActorLeaseHeld } from "./prActorLease.js";
import type { WriteFence } from "./writeFence.js";

function epochOf(fence: WriteFence | number | null | undefined): number | null {
  if (typeof fence === "number") return fence;
  if (fence == null || fence.kind === "unleased") return null;
  return fence.epoch;
}

/**
 * SQL predicates remain with their writers. This boundary owns only the
 * existing precheck/write/rejected-write recheck order; SQL-only state writers
 * deliberately request neither read.
 */
export async function fencedWrite<T>(
  client: Pool | PoolClient,
  workItemId: string,
  fence: WriteFence | number | null | undefined,
  checks: {
    readonly before: boolean;
    readonly rejected?: (result: T) => boolean;
  },
  write: () => Promise<T>,
): Promise<T> {
  const leaseEpoch = epochOf(fence);
  if (checks.before && leaseEpoch != null) {
    await assertPrActorLeaseHeld(client, workItemId, leaseEpoch);
  }
  const result = await write();
  if (leaseEpoch != null && checks.rejected?.(result)) {
    await assertPrActorLeaseHeld(client, workItemId, leaseEpoch);
  }
  return result;
}
