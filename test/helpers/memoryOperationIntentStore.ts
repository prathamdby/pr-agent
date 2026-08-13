import crypto from "node:crypto";
import type { IntakeClient } from "../../src/db/postgres.js";
import type {
  OperationIntentRow,
  OperationIntentStatus,
} from "../../src/agentWork/operationIntentRepository.js";
import type { JsonObject } from "../../src/util/jsonValue.js";

type PersistParams = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly detail?: JsonObject;
};

type ReconcileParams = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly status: Exclude<OperationIntentStatus, "pending">;
  readonly publishRecordId?: string | null;
  readonly detail?: JsonObject;
};

type MergeDetailParams = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly detail: JsonObject;
};

type StoredIntent = {
  id: string;
  workItemId: string;
  operationKey: string;
  mutationKind: string;
  status: OperationIntentStatus;
  publishRecordId: string | null;
  detail: JsonObject;
  createdAtMs: number;
  updatedAtMs: number;
};

function rowKey(workItemId: string, operationKey: string): string {
  return `${workItemId}\0${operationKey}`;
}

function toRow(stored: StoredIntent): OperationIntentRow {
  return {
    id: stored.id,
    workItemId: stored.workItemId,
    operationKey: stored.operationKey,
    mutationKind: stored.mutationKind,
    status: stored.status,
    publishRecordId: stored.publishRecordId,
    detail: { ...stored.detail },
  };
}

/**
 * In-memory stand-in for operation_intents SQL semantics used by unit tests.
 * Matches ON CONFLICT (work_item_id, operation_key) DO UPDATE SET updated_at only,
 * and reconcile detail merge via jsonb `||` (right-hand keys win).
 */
export function createMemoryOperationIntentStore() {
  const rows = new Map<string, StoredIntent>();
  let failNextReconcileError: Error | null = null;
  let failNextReconcileRemaining = 0;
  let clockMs = 1;

  function nextClock(): number {
    clockMs += 1;
    return clockMs;
  }

  return {
    reset(): void {
      rows.clear();
      failNextReconcileError = null;
      failNextReconcileRemaining = 0;
      clockMs = 1;
    },

    /**
     * Crash hook for post-mutate / pre-reconcile restart tests.
     * Defaults to failing once: after mutate() succeeds, withOperationIntent
     * does not mark failed on persist/reconcile errors (leaves __mutating /
     * __result pending). One failed success-path reconcile matches process death
     * before status flip; redelivery finishes reconcile without remutating.
     */
    failNextReconcile(error?: Error, times = 1): void {
      failNextReconcileError = error ?? new Error("simulated crash before reconcile");
      failNextReconcileRemaining = times;
    },

    get(workItemId: string, operationKey: string): OperationIntentRow | undefined {
      const stored = rows.get(rowKey(workItemId, operationKey));
      return stored ? toRow(stored) : undefined;
    },

    async getOperationIntent(
      _client: IntakeClient,
      workItemId: string,
      operationKey: string,
    ): Promise<OperationIntentRow | null> {
      const stored = rows.get(rowKey(workItemId, operationKey));
      return stored ? toRow(stored) : null;
    },

    async persist(_client: IntakeClient, params: PersistParams): Promise<OperationIntentRow> {
      const key = rowKey(params.workItemId, params.operationKey);
      const existing = rows.get(key);
      if (existing) {
        existing.updatedAtMs = nextClock();
        return toRow(existing);
      }
      const now = nextClock();
      const stored: StoredIntent = {
        id: crypto.randomUUID(),
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
        status: "pending",
        publishRecordId: null,
        detail: { ...params.detail },
        createdAtMs: now,
        updatedAtMs: now,
      };
      rows.set(key, stored);
      return toRow(stored);
    },

    async mergeDetail(
      _client: IntakeClient,
      params: MergeDetailParams,
    ): Promise<OperationIntentRow | null> {
      const key = rowKey(params.workItemId, params.operationKey);
      const existing = rows.get(key);
      if (!existing || (existing.status !== "pending" && existing.status !== "failed")) {
        return null;
      }
      if (existing.status === "failed") {
        existing.status = "pending";
      }
      existing.detail = { ...existing.detail, ...params.detail };
      existing.updatedAtMs = nextClock();
      return toRow(existing);
    },

    async reconcile(
      _client: IntakeClient,
      params: ReconcileParams,
    ): Promise<OperationIntentRow | null> {
      if (failNextReconcileRemaining > 0 && failNextReconcileError) {
        failNextReconcileRemaining -= 1;
        const error = failNextReconcileError;
        if (failNextReconcileRemaining === 0) {
          failNextReconcileError = null;
        }
        throw error;
      }
      const key = rowKey(params.workItemId, params.operationKey);
      const existing = rows.get(key);
      if (!existing) return null;
      existing.status = params.status;
      if (params.publishRecordId !== undefined && params.publishRecordId !== null) {
        existing.publishRecordId = params.publishRecordId;
      }
      if (params.detail) {
        existing.detail = { ...existing.detail, ...params.detail };
      }
      existing.updatedAtMs = nextClock();
      return toRow(existing);
    },

    async listPending(
      _client: IntakeClient,
      workItemId: string,
    ): Promise<readonly OperationIntentRow[]> {
      return [...rows.values()]
        .filter((row) => row.workItemId === workItemId && row.status === "pending")
        .sort((a, b) => a.createdAtMs - b.createdAtMs)
        .map(toRow);
    },
  };
}

export type MemoryOperationIntentStore = ReturnType<typeof createMemoryOperationIntentStore>;

export function memoryOperationIntentRepository(
  store: MemoryOperationIntentStore,
): import("../../src/agentWork/operationIntentRepository.js").OperationIntentRepository {
  return {
    persistOperationIntent: store.persist,
    mergeOperationIntentDetail: store.mergeDetail,
    reconcileOperationIntent: store.reconcile,
    getOperationIntent: store.getOperationIntent,
    listPendingOperationIntents: store.listPending,
  };
}
