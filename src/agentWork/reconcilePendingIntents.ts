import type { IntakeClient } from "../db/postgres.js";
import { logInfo } from "../evlog.js";
import { queryOne } from "../db/postgres.js";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../util/jsonValue.js";
import {
  listPendingOperationIntents,
  reconcileOperationIntent,
  type OperationIntentRow,
} from "./operationIntentRepository.js";

type ReconcilePendingIntentsResult = {
  readonly reconciled: number;
  readonly stillPending: number;
};

const TRIAGE_THREAD_KEY = /^triage:thread:(\d+)(?::resolve)?$/;
const VERIFICATION_THREAD_KEY = /^verification:thread:(\d+)$/;

function triageThreadRootFromOperationKey(operationKey: string): {
  readonly rootCommentId: number;
  readonly isResolve: boolean;
} | null {
  const match = TRIAGE_THREAD_KEY.exec(operationKey);
  if (!match) return null;
  return {
    rootCommentId: Number(match[1]),
    isResolve: operationKey.endsWith(":resolve"),
  };
}

function verificationThreadRootFromOperationKey(operationKey: string): number | null {
  const match = VERIFICATION_THREAD_KEY.exec(operationKey);
  return match ? Number(match[1]) : null;
}

/**
 * Find a completed publish_record that proves this operation already landed.
 * Match on operation identity (key + kind-specific ledger shape), never on
 * shared detail alone — triage reply vs :resolve share threadRootCommentId.
 */
async function findCompletedPublishRecordIdSql(
  client: IntakeClient,
  workItemId: string,
  intent: OperationIntentRow,
): Promise<string | null> {
  const detail = intent.detail;
  const step = detail.step;
  if (step === undefined || !isJsonString(step)) return null;

  const triageThread = triageThreadRootFromOperationKey(intent.operationKey);
  // Resolve has no publish_records row; never borrow the reply ledger.
  if (triageThread?.isResolve) {
    return null;
  }

  const values: Array<string | number> = [workItemId, step];
  let query = `SELECT id
                 FROM publish_records
                WHERE work_item_id = $1
                  AND step = $2
                  AND status = 'completed'`;

  const reviewLens = detail.reviewLens;
  if (reviewLens !== undefined && isJsonString(reviewLens)) {
    values.push(reviewLens);
    query += ` AND review_lens = $${values.length}`;
  }

  const resourceKey = detail.resourceKey;
  if (resourceKey !== undefined && isJsonString(resourceKey)) {
    values.push(resourceKey);
    query += ` AND resource_key = $${values.length}`;
  }

  const batchId = detail.batchId;
  if (batchId !== undefined && isJsonString(batchId)) {
    values.push(batchId);
    query += ` AND detail @> jsonb_build_object('batches', jsonb_build_array(jsonb_build_object('batchId', $${values.length}::text)))`;
  }

  if (triageThread != null) {
    values.push(String(triageThread.rootCommentId));
    query += ` AND detail @> jsonb_build_object('actedThreadIds', jsonb_build_array(($${values.length}::text)::bigint))`;
  } else {
    const verificationRoot = verificationThreadRootFromOperationKey(intent.operationKey);
    if (verificationRoot != null) {
      values.push(String(verificationRoot));
      // ADR-0023 ledger: { threads: { "<rootCommentId>": { ... } } }
      query += ` AND detail -> 'threads' ? $${values.length}::text`;
    } else {
      const threadRootCommentId = detail.threadRootCommentId;
      if (threadRootCommentId !== undefined && isJsonNumber(threadRootCommentId)) {
        values.push(String(threadRootCommentId));
        query += ` AND detail @> jsonb_build_object('threadRootCommentId', ($${values.length}::text)::bigint)`;
      }
    }
  }

  query += " ORDER BY updated_at DESC LIMIT 1";

  const row = await queryOne<{ id: string }>(client, query, values);
  return row?.id ?? null;
}

async function reconcilePendingIntentsSql(
  client: IntakeClient,
  workItemId: string,
): Promise<ReconcilePendingIntentsResult> {
  const pending = await listPendingOperationIntents(client, workItemId);
  let reconciled = 0;

  for (const intent of pending) {
    const publishRecordId = await findCompletedPublishRecordId(client, workItemId, intent);
    if (publishRecordId == null) continue;

    const row = await reconcileOperationIntent(client, {
      workItemId,
      operationKey: intent.operationKey,
      status: "reconciled",
      publishRecordId,
      detail: { reconciledFromPublishRecord: true },
    });
    if (row != null) reconciled += 1;
  }

  const stillPending = pending.length - reconciled;
  if (reconciled > 0) {
    logInfo("operation_intents_reconciled", {
      workItemId,
      reconciled,
      stillPending,
    });
  }

  return { reconciled, stillPending };
}

export type PendingIntentReconcile = typeof reconcilePendingIntentsSql;
export type PublishRecordLookup = typeof findCompletedPublishRecordIdSql;

let activePendingIntentReconcile: PendingIntentReconcile = reconcilePendingIntentsSql;
let activePublishRecordLookup: PublishRecordLookup = findCompletedPublishRecordIdSql;

export function setPendingIntentReconcile(reconcile: PendingIntentReconcile): void {
  activePendingIntentReconcile = reconcile;
}

export function setPublishRecordLookup(lookup: PublishRecordLookup): void {
  activePublishRecordLookup = lookup;
}

export function resetPendingIntentRecovery(): void {
  activePendingIntentReconcile = reconcilePendingIntentsSql;
  activePublishRecordLookup = findCompletedPublishRecordIdSql;
}

export async function reconcilePendingIntents(
  ...args: Parameters<PendingIntentReconcile>
): ReturnType<PendingIntentReconcile> {
  return activePendingIntentReconcile(...args);
}

export async function findCompletedPublishRecordId(
  ...args: Parameters<PublishRecordLookup>
): ReturnType<PublishRecordLookup> {
  return activePublishRecordLookup(...args);
}

export function intentDetailMatchesPublishRecord(
  intentDetail: JsonObject,
  publishDetail: JsonValue,
): boolean {
  if (!isJsonObject(publishDetail)) return false;
  const batchId = intentDetail.batchId;
  if (batchId !== undefined && isJsonString(batchId)) {
    const batches = publishDetail.batches;
    if (!Array.isArray(batches)) return false;
    return batches.some((batch) => isJsonObject(batch) && batch.batchId === batchId);
  }
  return true;
}
