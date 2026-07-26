import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  OperationIntentRow,
  OperationIntentStatus,
} from "../../src/agentWork/operationIntentRepository.js";

type PersistParams = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly detail?: Record<string, unknown>;
};

type ReconcileParams = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly status: Exclude<OperationIntentStatus, "pending">;
  readonly publishRecordId?: string | null;
  readonly detail?: Record<string, unknown>;
};

type MergeDetailParams = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly detail: Record<string, unknown>;
};

type StoredIntent = {
  id: string;
  workItemId: string;
  operationKey: string;
  mutationKind: string;
  status: OperationIntentStatus;
  publishRecordId: string | null;
  detail: Record<string, unknown>;
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
     * Defaults to failing twice so `withOperationIntent`'s catch-path
     * `reconcile(... failed)` also aborts, leaving the row `pending` —
     * matching a process death where neither reconcile runs.
     */
    failNextReconcile(error?: Error, times = 2): void {
      failNextReconcileError = error ?? new Error("simulated crash before reconcile");
      failNextReconcileRemaining = times;
    },

    get(workItemId: string, operationKey: string): OperationIntentRow | undefined {
      const stored = rows.get(rowKey(workItemId, operationKey));
      return stored ? toRow(stored) : undefined;
    },

    async getOperationIntent(
      _client: Pool | PoolClient,
      workItemId: string,
      operationKey: string,
    ): Promise<OperationIntentRow | null> {
      const stored = rows.get(rowKey(workItemId, operationKey));
      return stored ? toRow(stored) : null;
    },

    async persist(
      _client: Pool | PoolClient,
      params: PersistParams,
    ): Promise<OperationIntentRow> {
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
        detail: { ...(params.detail ?? {}) },
        createdAtMs: now,
        updatedAtMs: now,
      };
      rows.set(key, stored);
      return toRow(stored);
    },

    async mergeDetail(
      _client: Pool | PoolClient,
      params: MergeDetailParams,
    ): Promise<OperationIntentRow | null> {
      const key = rowKey(params.workItemId, params.operationKey);
      const existing = rows.get(key);
      if (!existing || existing.status !== "pending") return null;
      existing.detail = { ...existing.detail, ...params.detail };
      existing.updatedAtMs = nextClock();
      return toRow(existing);
    },

    async reconcile(
      _client: Pool | PoolClient,
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
      _client: Pool | PoolClient,
      workItemId: string,
    ): Promise<readonly OperationIntentRow[]> {
      return [...rows.values()]
        .filter((row) => row.workItemId === workItemId && row.status === "pending")
        .sort((a, b) => a.createdAtMs - b.createdAtMs)
        .map(toRow);
    },
  };
}
