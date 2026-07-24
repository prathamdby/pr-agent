import { vi } from "vitest";

vi.mock("../../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  intentDetailMatchesPublishRecord: vi.fn(() => true),
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
