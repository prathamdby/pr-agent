import { vi } from "vitest";
import type { PublishIntentStore } from "../../src/agentWork/publishOnce.ts";

export function operationIntentRepositoryMock(state: { readonly store: PublishIntentStore }) {
  return {
    persistOperationIntent: vi.fn(
      (...args: Parameters<PublishIntentStore["persistOperationIntent"]>) =>
        state.store.persistOperationIntent(...args),
    ),
    mergeOperationIntentDetail: vi.fn(
      (...args: Parameters<PublishIntentStore["mergeOperationIntentDetail"]>) =>
        state.store.mergeOperationIntentDetail(...args),
    ),
    reconcileOperationIntent: vi.fn(
      (...args: Parameters<PublishIntentStore["reconcileOperationIntent"]>) =>
        state.store.reconcileOperationIntent(...args),
    ),
    getOperationIntent: vi.fn((...args: Parameters<PublishIntentStore["getOperationIntent"]>) =>
      state.store.getOperationIntent(...args),
    ),
    listPendingOperationIntents: vi.fn(
      (...args: Parameters<PublishIntentStore["listPendingOperationIntents"]>) =>
        state.store.listPendingOperationIntents(...args),
    ),
    findInFlightMutatingIntent: vi.fn(
      (...args: Parameters<PublishIntentStore["findInFlightMutatingIntent"]>) =>
        state.store.findInFlightMutatingIntent(...args),
    ),
  };
}
