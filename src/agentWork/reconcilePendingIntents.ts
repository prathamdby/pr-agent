import type { Pool, PoolClient } from "pg";
import { logInfo } from "../evlog.js";
import { queryOne } from "../db/postgres.js";
import { isRecord } from "../util/typeGuards.js";
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
export async function findCompletedPublishRecordId(
  client: Pool | PoolClient,
  workItemId: string,
  intent: OperationIntentRow,
): Promise<string | null> {
  const detail = intent.detail;
  const step = detail.step;
  if (typeof step !== "string") return null;

  const triageThread = triageThreadRootFromOperationKey(intent.operationKey);
  // Resolve has no publish_records row; never borrow the reply ledger.
  if (triageThread?.isResolve) {
    return null;
  }

  const values: unknown[] = [workItemId, step];
  let query = `SELECT id
                 FROM publish_records
                WHERE work_item_id = $1
                  AND step = $2
                  AND status = 'completed'`;

  const reviewLens = detail.reviewLens;
  if (typeof reviewLens === "string") {
    values.push(reviewLens);
    query += ` AND review_lens = $${values.length}`;
  }

  const resourceKey = detail.resourceKey;
  if (typeof resourceKey === "string") {
    values.push(resourceKey);
    query += ` AND resource_key = $${values.length}`;
  }

  const batchId = detail.batchId;
  if (typeof batchId === "string") {
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
      if (typeof threadRootCommentId === "number") {
        values.push(String(threadRootCommentId));
        query += ` AND detail @> jsonb_build_object('threadRootCommentId', ($${values.length}::text)::bigint)`;
      }
    }
  }

  query += " ORDER BY updated_at DESC LIMIT 1";

  const row = await queryOne<{ id: string }>(client, query, values);
  return row?.id ?? null;
}

export async function reconcilePendingIntents(
  client: Pool | PoolClient,
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

export function intentDetailMatchesPublishRecord(
  intentDetail: Record<string, unknown>,
  publishDetail: unknown,
): boolean {
  if (!isRecord(publishDetail)) return false;
  const batchId = intentDetail.batchId;
  if (typeof batchId === "string") {
    const batches = publishDetail.batches;
    if (!Array.isArray(batches)) return false;
    return batches.some((batch) => isRecord(batch) && batch.batchId === batchId);
  }
  return true;
}
