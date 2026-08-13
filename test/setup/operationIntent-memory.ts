import { beforeEach } from "vitest";
import {
  resetOperationIntentRepository,
  setOperationIntentRepository,
} from "../../src/agentWork/operationIntentRepository.js";
import {
  resetPendingIntentRecovery,
  setPendingIntentReconcile,
  setPublishRecordLookup,
} from "../../src/agentWork/reconcilePendingIntents.js";
import {
  createMemoryOperationIntentStore,
  memoryOperationIntentRepository,
} from "../helpers/memoryOperationIntentStore.js";

/**
 * Default unit-test durability: real `withOperationIntent` against an in-memory
 * intent store that mirrors operation_intents SQL semantics.
 */
export const memoryOperationIntentStore = createMemoryOperationIntentStore();

setOperationIntentRepository(memoryOperationIntentRepository(memoryOperationIntentStore));
setPendingIntentReconcile(async () => ({ reconciled: 0, stillPending: 0 }));
setPublishRecordLookup(async () => null);

beforeEach(() => {
  memoryOperationIntentStore.reset();
  setOperationIntentRepository(memoryOperationIntentRepository(memoryOperationIntentStore));
  setPendingIntentReconcile(async () => ({ reconciled: 0, stillPending: 0 }));
  setPublishRecordLookup(async () => null);
});

export function restorePostgresOperationIntents(): void {
  resetOperationIntentRepository();
  resetPendingIntentRecovery();
}
