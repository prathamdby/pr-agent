import type { Pool, PoolClient } from "pg";
import { assertPrActorLeaseHeld } from "./prActorLease.js";

/**
 * SQL predicates remain with their writers. This boundary owns only the
 * existing precheck/write/rejected-write recheck order; SQL-only state writers
 * deliberately request neither read.
 */
export async function fencedWrite<T>(
  client: Pool | PoolClient,
  workItemId: string,
  leaseEpoch: number | null | undefined,
  checks: {
    readonly before: boolean;
    readonly rejected?: (result: T) => boolean;
  },
  write: () => Promise<T>,
): Promise<T> {
  if (checks.before && typeof leaseEpoch === "number") {
    await assertPrActorLeaseHeld(client, workItemId, leaseEpoch);
  }
  const result = await write();
  if (typeof leaseEpoch === "number" && checks.rejected?.(result)) {
    await assertPrActorLeaseHeld(client, workItemId, leaseEpoch);
  }
  return result;
}
