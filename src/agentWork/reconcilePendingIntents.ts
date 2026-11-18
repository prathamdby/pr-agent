import type { Pool, PoolClient } from "pg";
import { logInfo } from "../evlog.ts";
import { queryOne } from "../db/postgres.ts";
import {
  listPendingOperationIntents,
  reconcileOperationIntent,
  type OperationIntentRow,
} from "./operationIntentRepository.ts";
import {
  matchesVerificationThreadCompletion,
  parseVerificationThreadLedger,
} from "./verificationThreadLedger.ts";

type ReconcilePendingIntentsResult = {
  readonly reconciled: number;
  readonly stillPending: number;
};

const TRIAGE_THREAD_KEY = /^triage:thread:(\d+)(?::resolve)?$/;
const VERIFICATION_THREAD_KEY = /^verification:thread:(\d+)$/;

function triageThreadRootFromOperationKey(operationKey: string) {
  const match = TRIAGE_THREAD_KEY.exec(operationKey);
  if (!match)
    return ((
      pinnedReturn: {
        readonly rootCommentId: number;
        readonly isResolve: boolean;
      } | null,
    ) => pinnedReturn)(null);
  return ((
    pinnedReturn: {
      readonly rootCommentId: number;
      readonly isResolve: boolean;
    } | null,
  ) => pinnedReturn)({
    rootCommentId: Number(match[1]),
    isResolve: operationKey.endsWith(":resolve"),
  });
}

function verificationThreadRootFromOperationKey(operationKey: string) {
  const match = VERIFICATION_THREAD_KEY.exec(operationKey);
  return ((pinnedReturn: number | null) => pinnedReturn)(match ? Number(match[1]) : null);
}

export async function findCompletedPublishRecordId(
  client: Pool | PoolClient,
  workItemId: string,
  intent: OperationIntentRow,
) {
  const detail = intent.detail;
  const step = detail.step;
  if (typeof step !== "string")
    return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(null);

  const triageThread = triageThreadRootFromOperationKey(intent.operationKey);
  const verificationRoot = verificationThreadRootFromOperationKey(intent.operationKey);
  if (
    verificationRoot != null &&
    (typeof detail.headSha !== "string" ||
      typeof detail.verdict !== "string" ||
      typeof detail.requiresStub !== "boolean")
  ) {
    return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(null);
  }
  if (triageThread?.isResolve) {
    return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(null);
  }

  const values: unknown[] = [workItemId, step];
  let query = `SELECT id, detail
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
    if (verificationRoot != null) {
      values.push(String(verificationRoot));
      const rootIndex = values.length;
      values.push(
        JSON.stringify({
          workItemId,
          operationKey: intent.operationKey,
          headSha: detail.headSha,
          verdict: detail.verdict,
        }),
      );
      query += ` AND detail -> 'threads' -> $${rootIndex}::text -> 'completion' @> $${values.length}::jsonb`;
    } else {
      const threadRootCommentId = detail.threadRootCommentId;
      if (typeof threadRootCommentId === "number") {
        values.push(String(threadRootCommentId));
        query += ` AND detail @> jsonb_build_object('threadRootCommentId', ($${values.length}::text)::bigint)`;
      }
    }
  }

  query += " ORDER BY updated_at DESC LIMIT 1";

  const row = await queryOne<{ id: string; detail: unknown }>(client, query, values);
  if (row != null && verificationRoot != null) {
    const receipt = parseVerificationThreadLedger(row.detail).threads[String(verificationRoot)]
      ?.completion;
    if (
      !matchesVerificationThreadCompletion(receipt, {
        workItemId,
        operationKey: intent.operationKey,
        headSha: detail.headSha,
        verdict: detail.verdict,
        requiresStub: detail.requiresStub,
      })
    )
      return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(null);
  }
  return ((pinnedReturn: (string | null) | Promise<string | null>) => pinnedReturn)(
    row?.id ?? null,
  );
}

export async function reconcilePendingIntents(
  client: Pool | PoolClient,
  workItemId: string,
  leaseEpoch?: number | null,
) {
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
      leaseEpoch,
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

  return ((pinnedReturn: ReconcilePendingIntentsResult | Promise<ReconcilePendingIntentsResult>) =>
    pinnedReturn)({ reconciled, stillPending });
}
