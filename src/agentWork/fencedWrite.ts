import type { Pool, PoolClient } from "pg";
import { assertPrActorLeaseHeld } from "./prActorLease.ts";
import type { WriteFence } from "./writeFence.ts";

function epochOf(fence: WriteFence | number | null | undefined) {
  if (typeof fence === "number") return ((pinnedReturn: number | null) => pinnedReturn)(fence);
  if (fence == null || fence.kind === "unleased")
    return ((pinnedReturn: number | null) => pinnedReturn)(null);
  return ((pinnedReturn: number | null) => pinnedReturn)(fence.epoch);
}

export async function fencedWrite<T>(
  client: Pool | PoolClient,
  workItemId: string,
  fence: WriteFence | number | null | undefined,
  checks: {
    readonly before: boolean;
    readonly rejected?: (result: T) => boolean;
  },
  write: () => Promise<T>,
) {
  const leaseEpoch = epochOf(fence);
  if (checks.before && leaseEpoch != null) {
    await assertPrActorLeaseHeld(client, workItemId, leaseEpoch);
  }
  const result = await write();
  if (leaseEpoch != null && checks.rejected?.(result)) {
    await assertPrActorLeaseHeld(client, workItemId, leaseEpoch);
  }
  return ((pinnedReturn: T | Promise<T>) => pinnedReturn)(result);
}
