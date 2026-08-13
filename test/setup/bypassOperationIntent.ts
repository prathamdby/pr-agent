import { withOperationIntent } from "../../src/agentWork/withOperationIntent.js";

/**
 * Opt-in helper for suites that never exercise publish durability.
 * Call `mutate()` directly instead of wrapping with operation intent.
 */
export async function bypassOperationIntent<T>(
  params: Parameters<typeof withOperationIntent<T>>[0],
): Promise<T> {
  return params.mutate();
}
