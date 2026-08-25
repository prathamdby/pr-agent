import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors/appError.js";
import { queryOne } from "../db/postgres.js";
import { assertPrActorLeaseHeld } from "./prActorLease.js";

export type OperationIntentStatus = "pending" | "reconciled" | "failed" | "outcome_unknown";

export type OperationIntentRow = {
  readonly id: string;
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly status: OperationIntentStatus;
  readonly publishRecordId: string | null;
  readonly leaseEpoch?: number | null;
  readonly detail: Record<string, unknown>;
};

export async function persistOperationIntent(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly mutationKind: string;
    readonly leaseEpoch?: number | null;
    readonly detail?: Record<string, unknown>;
  },
): Promise<OperationIntentRow> {
  if (params.leaseEpoch != null) {
    await assertPrActorLeaseHeld(client, params.workItemId, params.leaseEpoch);
  }
  const id = crypto.randomUUID();
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    lease_epoch: string | number | null;
    detail: Record<string, unknown>;
  }>(
    client,
    `INSERT INTO operation_intents (
       id, work_item_id, operation_key, mutation_kind, status, lease_epoch, detail
     )
     SELECT $1, $2, $3, $4, 'pending', $5, $6::jsonb
      WHERE $5::bigint IS NULL
         OR EXISTS (
              SELECT 1
                FROM pr_actor_leases
               WHERE work_item_id = $2
                 AND lease_epoch = $5
            )
     ON CONFLICT (work_item_id, operation_key) DO UPDATE SET
       lease_epoch = COALESCE(EXCLUDED.lease_epoch, operation_intents.lease_epoch),
       updated_at = now()
     WHERE $5::bigint IS NULL
        OR EXISTS (
             SELECT 1
               FROM pr_actor_leases
              WHERE work_item_id = EXCLUDED.work_item_id
                AND lease_epoch = $5
           )
     RETURNING id, work_item_id, operation_key, mutation_kind, status, publish_record_id, lease_epoch, detail`,
    [
      id,
      params.workItemId,
      params.operationKey,
      params.mutationKind,
      params.leaseEpoch ?? null,
      JSON.stringify(params.detail ?? {}),
    ],
  );
  if (!row) {
    if (params.leaseEpoch != null) {
      await assertPrActorLeaseHeld(client, params.workItemId, params.leaseEpoch);
    }
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

/**
 * Merge detail into a pending or failed intent.
 * Failed rows reopen to pending so the in-flight marker can re-arm across retries.
 * Reconciled / outcome_unknown rows are left untouched (never auto-remutate).
 */
export async function mergeOperationIntentDetail(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly leaseEpoch?: number | null;
    readonly detail: Record<string, unknown>;
  },
): Promise<OperationIntentRow | null> {
  if (params.leaseEpoch != null) {
    await assertPrActorLeaseHeld(client, params.workItemId, params.leaseEpoch);
  }
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    lease_epoch: string | number | null;
    detail: Record<string, unknown>;
  }>(
    client,
    `UPDATE operation_intents
        SET status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
            reconciled_at = CASE WHEN status = 'failed' THEN NULL ELSE reconciled_at END,
            lease_epoch = COALESCE($3::bigint, lease_epoch),
            detail = detail || $4::jsonb,
            updated_at = now()
      WHERE work_item_id = $1
        AND operation_key = $2
        AND status IN ('pending', 'failed')
        AND ($3::bigint IS NULL OR EXISTS (
          SELECT 1 FROM pr_actor_leases
           WHERE work_item_id = $1 AND lease_epoch = $3
        ))
      RETURNING id, work_item_id, operation_key, mutation_kind, status, publish_record_id, lease_epoch, detail`,
    [
      params.workItemId,
      params.operationKey,
      params.leaseEpoch ?? null,
      JSON.stringify(params.detail),
    ],
  );
  return row ? mapRow(row) : null;
}

export async function reconcileOperationIntent(
  client: Pool | PoolClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly status: Exclude<OperationIntentStatus, "pending">;
    readonly publishRecordId?: string | null;
    readonly leaseEpoch?: number | null;
    readonly detail?: Record<string, unknown>;
  },
): Promise<OperationIntentRow | null> {
  if (params.leaseEpoch != null) {
    await assertPrActorLeaseHeld(client, params.workItemId, params.leaseEpoch);
  }
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    lease_epoch: string | number | null;
    detail: Record<string, unknown>;
  }>(
    client,
    `UPDATE operation_intents
        SET status = $3,
            publish_record_id = COALESCE($4::uuid, publish_record_id),
            lease_epoch = COALESCE($6::bigint, lease_epoch),
            detail = CASE
              WHEN $5::jsonb IS NULL THEN detail
              ELSE detail || $5::jsonb
            END,
            reconciled_at = now(),
            updated_at = now()
      WHERE work_item_id = $1
        AND operation_key = $2
        AND ($6::bigint IS NULL OR EXISTS (
          SELECT 1 FROM pr_actor_leases
           WHERE work_item_id = $1 AND lease_epoch = $6
        ))
      RETURNING id, work_item_id, operation_key, mutation_kind, status, publish_record_id, lease_epoch, detail`,
    [
      params.workItemId,
      params.operationKey,
      params.status,
      params.publishRecordId ?? null,
      params.detail ? JSON.stringify(params.detail) : null,
      params.leaseEpoch ?? null,
    ],
  );
  return row ? mapRow(row) : null;
}

export async function getOperationIntent(
  client: Pool | PoolClient,
  workItemId: string,
  operationKey: string,
): Promise<OperationIntentRow | null> {
  const row = await queryOne<{
    id: string;
    work_item_id: string;
    operation_key: string;
    mutation_kind: string;
    status: OperationIntentStatus;
    publish_record_id: string | null;
    lease_epoch: string | number | null;
    detail: Record<string, unknown>;
  }>(
    client,
    `SELECT id, work_item_id, operation_key, mutation_kind, status, publish_record_id, lease_epoch, detail
       FROM operation_intents
      WHERE work_item_id = $1
        AND operation_key = $2
      LIMIT 1`,
    [workItemId, operationKey],
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
    lease_epoch: string | number | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT id, work_item_id, operation_key, mutation_kind, status, publish_record_id, lease_epoch, detail
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
  lease_epoch: string | number | null;
  detail: Record<string, unknown>;
}): OperationIntentRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    operationKey: row.operation_key,
    mutationKind: row.mutation_kind,
    status: row.status,
    publishRecordId: row.publish_record_id,
    leaseEpoch: row.lease_epoch == null ? null : Number(row.lease_epoch),
    detail: row.detail,
  };
}
