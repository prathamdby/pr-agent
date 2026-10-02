import { fencedWrite } from "./fencedWrite.js";
import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors/appError.js";
import { queryOne } from "../db/postgres.js";

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

type RetainedDescriptionLookup = {
  readonly workItemId: string;
  readonly operationKey: string;
  readonly parentOperationKey?: string;
  readonly operationMarker?: string;
};

export type RetainedDescriptionSurfaceIdentity = {
  readonly operationKey: string;
  readonly inputHash: string;
};

/**
 * Select the one retained description child whose stored scope and hash prove
 * its key. Ambiguous or unprovable rows fail closed; rows must already be
 * filtered to the exact work item, mutation, scope, and marker (LIMIT 2).
 */
export function selectRetainedDescriptionSurfaceIdentity(
  rows: readonly {
    readonly operation_key: string;
    readonly detail: Record<string, unknown>;
  }[],
  params: RetainedDescriptionLookup,
): RetainedDescriptionSurfaceIdentity | null {
  const retained = rows[0];
  if (retained == null) return null;
  const inputHash = retained.detail.inputHash;
  const prefix =
    params.parentOperationKey == null
      ? "pr-surface:publishDescription:"
      : `${params.parentOperationKey}:surface:publishDescription:`;
  if (
    rows.length !== 1 ||
    (retained.detail.parentOperationKey ?? undefined) !== params.parentOperationKey ||
    (retained.detail.operationMarker ?? undefined) !== params.operationMarker ||
    typeof inputHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(inputHash) ||
    retained.operation_key !== `${prefix}${inputHash}` ||
    (!params.operationMarker && retained.operation_key !== params.operationKey)
  ) {
    throw new AppError({
      domain: "operation_intent",
      kind: "description_identity_conflict",
      message: "Retained description mutation identity is ambiguous or cannot be proved",
      context: { workItemId: params.workItemId, operationKey: params.operationKey },
    });
  }
  return { operationKey: retained.operation_key, inputHash };
}

/** Removed Config fields cannot reconstruct a retained description child's hash. */
export async function findRetainedDescriptionSurfaceIdentity(
  client: Pool | PoolClient,
  params: RetainedDescriptionLookup,
): Promise<RetainedDescriptionSurfaceIdentity | null> {
  const { rows } = await client.query<{
    operation_key: string;
    detail: Record<string, unknown>;
  }>(
    `SELECT operation_key, detail
       FROM operation_intents
      WHERE work_item_id = $1
        AND mutation_kind = 'github.pr_surface.publishDescription'
        AND detail->>'surfaceMethod' = 'publishDescription'
        AND detail->>'parentOperationKey' IS NOT DISTINCT FROM $2::text
        AND detail->>'operationMarker' IS NOT DISTINCT FROM $3::text
      LIMIT 2`,
    [params.workItemId, params.parentOperationKey ?? null, params.operationMarker ?? null],
  );
  return selectRetainedDescriptionSurfaceIdentity(rows, params);
}

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
  const id = crypto.randomUUID();
  const row = await fencedWrite(
    client,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => written == null },
    () =>
      queryOne<{
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
      ),
  );
  if (!row) {
    throw new AppError({
      domain: "operation_intent",
      kind: "persist_no_row",
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
  const row = await fencedWrite(
    client,
    params.workItemId,
    params.leaseEpoch,
    { before: true },
    () =>
      queryOne<{
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
      ),
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
  const row = await fencedWrite(
    client,
    params.workItemId,
    params.leaseEpoch,
    { before: true },
    () =>
      queryOne<{
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
      ),
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
