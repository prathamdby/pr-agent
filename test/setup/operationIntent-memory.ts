import { beforeEach, vi } from "vitest";
import { createMemoryOperationIntentStore } from "../helpers/memoryOperationIntentStore.js";

/**
 * Default unit-test durability: real `withOperationIntent` against an in-memory
 * intent store that mirrors operation_intents SQL semantics.
 *
 * Do not reintroduce a global `mutate()` bypass here. Suites that must skip
 * intent sequencing can opt into `test/setup/bypassOperationIntent.ts`.
 */
export const memoryOperationIntentStore = createMemoryOperationIntentStore();

vi.mock("../../src/agentWork/operationIntentRepository.js", () => ({
  persistOperationIntent: (
    client: Parameters<typeof memoryOperationIntentStore.persist>[0],
    params: Parameters<typeof memoryOperationIntentStore.persist>[1],
  ) => memoryOperationIntentStore.persist(client, params),
  mergeOperationIntentDetail: (
    client: Parameters<typeof memoryOperationIntentStore.mergeDetail>[0],
    params: Parameters<typeof memoryOperationIntentStore.mergeDetail>[1],
  ) => memoryOperationIntentStore.mergeDetail(client, params),
  reconcileOperationIntent: (
    client: Parameters<typeof memoryOperationIntentStore.reconcile>[0],
    params: Parameters<typeof memoryOperationIntentStore.reconcile>[1],
  ) => memoryOperationIntentStore.reconcile(client, params),
  getOperationIntent: (
    client: Parameters<typeof memoryOperationIntentStore.getOperationIntent>[0],
    workItemId: string,
    operationKey: string,
  ) => memoryOperationIntentStore.getOperationIntent(client, workItemId, operationKey),
  listPendingOperationIntents: (
    client: Parameters<typeof memoryOperationIntentStore.listPending>[0],
    workItemId: string,
  ) => memoryOperationIntentStore.listPending(client, workItemId),
}));

// Unit tests rarely have publish_records rows; keep recovery as a no-op unless a
// suite unmocks this module and supplies DB/publish fixtures.
vi.mock("../../src/agentWork/reconcilePendingIntents.js", () => ({
  reconcilePendingIntents: vi.fn(async () => ({ reconciled: 0, stillPending: 0 })),
  findCompletedPublishRecordId: vi.fn(async () => null),
}));

beforeEach(() => {
  memoryOperationIntentStore.reset();
});
