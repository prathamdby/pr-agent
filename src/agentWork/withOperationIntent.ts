import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError, isAppError, toAppError } from "../errors/appError.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import {
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
} from "./operationIntentRepository.js";

export type OperationIntentContext = {
  readonly client: Pool | PoolClient;
  readonly workItemId: string;
  readonly resourceKey: string;
};

export type WithOperationIntentParams<T> = {
  readonly client: Pool | PoolClient;
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly detail?: Record<string, unknown>;
  readonly mutate: () => Promise<T>;
  readonly publishRecordId?: string | null;
  readonly reconcileDetail?: Record<string, unknown>;
};

export function askReplyOperationKey(resourceKey: string): string {
  return `ask:reply:${resourceKey}`;
}

export function descriptionPrBodyOperationKey(resourceKey: string): string {
  return `description:pr_body:${resourceKey}`;
}

export function reviewInlineBatchOperationKey(batchId: string): string {
  return `review:inline:${batchId}`;
}

/** Stable inline-batch identity for operation-intent keys across retries. */
export function deterministicInlineBatchId(params: {
  readonly workItemId: string;
  readonly specialist: string;
  readonly findingFingerprints: readonly string[];
}): string {
  const material = [
    params.workItemId,
    params.specialist,
    ...[...params.findingFingerprints].sort(),
  ].join("\0");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function reviewSummaryOperationKey(resourceKey: string, reviewLens: string): string {
  return `review:summary:${reviewLens}:${resourceKey}`;
}

export function triagePushOperationKey(resourceKey: string): string {
  return `triage:push:${resourceKey}`;
}

export function triageThreadOperationKey(rootCommentId: number): string {
  return `triage:thread:${rootCommentId}`;
}

export function triageReportOperationKey(resourceKey: string): string {
  return `triage:report:${resourceKey}`;
}

export function verificationThreadOperationKey(rootCommentId: number): string {
  return `verification:thread:${rootCommentId}`;
}

export async function withOperationIntent<T>(params: WithOperationIntentParams<T>): Promise<T> {
  const intent = await persistOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    mutationKind: params.mutationKind,
    detail: params.detail,
  });

  // Mutation outcome already stashed (reconciled, or crash/DB blip after mutate).
  // Never remutate when __result is present — finish status reconciliation only.
  if ("__result" in intent.detail) {
    if (intent.status !== "reconciled") {
      await reconcileOperationIntent(params.client, {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        status: "reconciled",
        publishRecordId: params.publishRecordId,
        detail: {
          ...params.reconcileDetail,
          __result: intent.detail.__result,
        },
      });
    }
    return intent.detail.__result as T;
  }

  try {
    const result = await params.mutate();
    const resultDetail = {
      ...params.reconcileDetail,
      ...(result === undefined ? {} : { __result: result as unknown }),
    };
    await mergeOperationIntentDetail(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      detail: resultDetail,
    });
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "reconciled",
      publishRecordId: params.publishRecordId,
      detail: resultDetail,
    });
    return result;
  } catch (error) {
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "failed",
      detail: {
        ...params.reconcileDetail,
        errorMessage: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
      },
    });
    if (isAppError(error)) throw error;
    throw toAppError(error, {
      code: "operation_intent.mutation_failed",
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
      },
    });
  }
}

export function requireOperationIntentContext(
  context: OperationIntentContext | undefined,
  feature: string,
): OperationIntentContext {
  if (context == null) {
    throw new AppError({
      code: "operation_intent.context_required",
      message: `Operation intent context is required for ${feature}`,
    });
  }
  return context;
}
