import { vi } from "vitest";

/**
 * Opt-in only for suites that never exercise publish durability.
 * Prefer the default memory intent store (`operationIntent-memory.ts`).
 */
vi.mock("../../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
}));

vi.mock("../../src/agentWork/withOperationIntent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agentWork/withOperationIntent.js")>();
  return {
    ...actual,
    withOperationIntent: vi.fn(
      async <T>(params: Parameters<typeof actual.withOperationIntent<T>>[0]): Promise<T> =>
        params.mutate(),
    ),
  };
});
