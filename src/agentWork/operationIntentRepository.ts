import crypto from "node:crypto";
import type { IntakeClient } from "../db/postgres.js";
import * as v from "valibot";
import { AppError } from "../errors/appError.js";
import { queryOne } from "../db/postgres.js";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../util/jsonValue.js";

export type OperationIntentStatus = "pending" | "reconciled" | "failed" | "outcome_unknown";

export type OperationIntentRow = {
  readonly id: string;
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly status: OperationIntentStatus;
  readonly publishRecordId: string | null;
  readonly detail: JsonObject;
};

type OperationIntentDbRow = {
  id: string;
  work_item_id: string;
  operation_key: string;
  mutation_kind: string;
  status: OperationIntentStatus;
  publish_record_id: string | null;
  detail: JsonValue;
};

async function persistOperationIntentSql(
  client: IntakeClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly mutationKind: string;
    readonly detail?: JsonObject;
  },
): Promise<OperationIntentRow> {
  const id = crypto.randomUUID();
  const row = await queryOne<OperationIntentDbRow>(
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

/**
 * Merge detail into a pending or failed intent.
 * Failed rows reopen to pending so the in-flight marker can re-arm across retries.
 * Reconciled / outcome_unknown rows are left untouched (never auto-remutate).
 */
async function mergeOperationIntentDetailSql(
  client: IntakeClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly detail: JsonObject;
  },
): Promise<OperationIntentRow | null> {
  const row = await queryOne<OperationIntentDbRow>(
    client,
    `UPDATE operation_intents
        SET status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
            reconciled_at = CASE WHEN status = 'failed' THEN NULL ELSE reconciled_at END,
            detail = detail || $3::jsonb,
            updated_at = now()
      WHERE work_item_id = $1
        AND operation_key = $2
        AND status IN ('pending', 'failed')
      RETURNING id, work_item_id, operation_key, mutation_kind, status, publish_record_id, detail`,
    [params.workItemId, params.operationKey, JSON.stringify(params.detail)],
  );
  return row ? mapRow(row) : null;
}

async function reconcileOperationIntentSql(
  client: IntakeClient,
  params: {
    readonly workItemId: string;
    readonly operationKey: string;
    readonly status: Exclude<OperationIntentStatus, "pending">;
    readonly publishRecordId?: string | null;
    readonly detail?: JsonObject;
  },
): Promise<OperationIntentRow | null> {
  const row = await queryOne<OperationIntentDbRow>(
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

async function getOperationIntentSql(
  client: IntakeClient,
  workItemId: string,
  operationKey: string,
): Promise<OperationIntentRow | null> {
  const row = await queryOne<OperationIntentDbRow>(
    client,
    `SELECT id, work_item_id, operation_key, mutation_kind, status, publish_record_id, detail
       FROM operation_intents
      WHERE work_item_id = $1
        AND operation_key = $2
      LIMIT 1`,
    [workItemId, operationKey],
  );
  return row ? mapRow(row) : null;
}

async function listPendingOperationIntentsSql(
  client: IntakeClient,
  workItemId: string,
): Promise<readonly OperationIntentRow[]> {
  const result = await client.query<OperationIntentDbRow>(
    `SELECT id, work_item_id, operation_key, mutation_kind, status, publish_record_id, detail
       FROM operation_intents
      WHERE work_item_id = $1
        AND status = 'pending'
      ORDER BY created_at ASC`,
    [workItemId],
  );
  return result.rows.map(mapRow);
}

function mapRow(row: OperationIntentDbRow): OperationIntentRow {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    operationKey: row.operation_key,
    mutationKind: row.mutation_kind,
    status: row.status,
    publishRecordId: row.publish_record_id,
    detail: v.parse(jsonObjectSchema, row.detail),
  };
}

export type OperationIntentRepository = {
  readonly persistOperationIntent: typeof persistOperationIntentSql;
  readonly mergeOperationIntentDetail: typeof mergeOperationIntentDetailSql;
  readonly reconcileOperationIntent: typeof reconcileOperationIntentSql;
  readonly getOperationIntent: typeof getOperationIntentSql;
  readonly listPendingOperationIntents: typeof listPendingOperationIntentsSql;
};

const postgresOperationIntentRepository: OperationIntentRepository = {
  persistOperationIntent: persistOperationIntentSql,
  mergeOperationIntentDetail: mergeOperationIntentDetailSql,
  reconcileOperationIntent: reconcileOperationIntentSql,
  getOperationIntent: getOperationIntentSql,
  listPendingOperationIntents: listPendingOperationIntentsSql,
};

let activeOperationIntentRepository: OperationIntentRepository = postgresOperationIntentRepository;

export function setOperationIntentRepository(repository: OperationIntentRepository): void {
  activeOperationIntentRepository = repository;
}

export function resetOperationIntentRepository(): void {
  activeOperationIntentRepository = postgresOperationIntentRepository;
}

export async function persistOperationIntent(
  ...args: Parameters<typeof persistOperationIntentSql>
): ReturnType<typeof persistOperationIntentSql> {
  return activeOperationIntentRepository.persistOperationIntent(...args);
}

export async function mergeOperationIntentDetail(
  ...args: Parameters<typeof mergeOperationIntentDetailSql>
): ReturnType<typeof mergeOperationIntentDetailSql> {
  return activeOperationIntentRepository.mergeOperationIntentDetail(...args);
}

export async function reconcileOperationIntent(
  ...args: Parameters<typeof reconcileOperationIntentSql>
): ReturnType<typeof reconcileOperationIntentSql> {
  return activeOperationIntentRepository.reconcileOperationIntent(...args);
}

export async function getOperationIntent(
  ...args: Parameters<typeof getOperationIntentSql>
): ReturnType<typeof getOperationIntentSql> {
  return activeOperationIntentRepository.getOperationIntent(...args);
}

export async function listPendingOperationIntents(
  ...args: Parameters<typeof listPendingOperationIntentsSql>
): ReturnType<typeof listPendingOperationIntentsSql> {
  return activeOperationIntentRepository.listPendingOperationIntents(...args);
}
