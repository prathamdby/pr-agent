import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors/appError.js";
import { queryOne } from "../db/postgres.js";

export type OperationIntentStatus = "pending" | "reconciled" | "failed";

export type OperationIntentRow = {
  readonly id: string;
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly status: OperationIntentStatus;
  readonly publishRecordId: string | null;
  readonly detail: Record<string, unknown>;
};

export async function persistOperationIntent(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly mutationKind: string;
    readonly detail?: Record<string, unknown>;
  },
): Promise<OperationIntentRow> {
  const id = crypto.randomUUID();
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    detail: Record<string, unknown>;
  }>(
    client,
    `INSERT INTO operation_intents (
       id, work_item_id, operation_key, mutation_kind, status, detail
     ) VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)
     ON CONFLICT (work_item_id, operation_key) DO UPDATE SET
       updated_at = now()
     RETURNING id, work_item_id, operation_key, mutation_kind, status, publish_record_id, detail`,
    [
      id,
      params.workItemId,
      params.operationKey,
      params.mutationKind,
      JSON.stringify(params.detail ?? {}),
    ],
  );
  if (!row) {
    throw new AppError({
      code: "operation_intent.persist_no_row",
      message: "persistOperationIntent returned no row",
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
      },
    });
  }
  return mapRow(row);
}

export async function reconcileOperationIntent(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly status: Exclude<OperationIntentStatus, "pending">;
    readonly publishRecordId?: string | null;
    readonly detail?: Record<string, unknown>;
  },
): Promise<OperationIntentRow | null> {
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    detail: Record<string, unknown>;
  }>(
    client,
    `UPDATE operation_intents
        SET status = $3,
            publish_record_id = COALESCE($4::uuid, publish_record_id),
            detail = CASE
              WHEN $5::jsonb IS NULL THEN detail
              ELSE detail || $5::jsonb
            END,
            reconciled_at = now(),
            updated_at = now()
      WHERE work_item_id = $1
        AND operation_key = $2
      RETURNING id, work_item_id, operation_key, mutation_kind, status, publish_record_id, detail`,
    [
      params.workItemId,
      params.operationKey,
      params.status,
      params.publishRecordId ?? null,
      params.detail ? JSON.stringify(params.detail) : null,
    ],
  );
  return row ? mapRow(row) : null;
}

export async function listPendingOperationIntents(
  client: Pool | PoolClient,
  workItemId: string,
): Promise<readonly OperationIntentRow[]> {
  const result = await client.query<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT id, work_item_id, operation_key, mutation_kind, status, publish_record_id, detail
       FROM operation_intents
      WHERE work_item_id = $1
        AND status = 'pending'
      ORDER BY created_at ASC`,
    [workItemId],
  );
  return result.rows.map(mapRow);
}

function mapRow(row: {
  id: string;
  work_item_id: string;
  operation_key: string;
  mutation_kind: string;
  status: OperationIntentStatus;
  publish_record_id: string | null;
  detail: Record<string, unknown>;
}): OperationIntentRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    operationKey: row.operation_key,
    mutationKind: row.mutation_kind,
    status: row.status,
    publishRecordId: row.publish_record_id,
    detail: row.detail,
  };
}
