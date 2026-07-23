import type { Pool, PoolClient } from "pg";
import { AppError, isAppError, toAppError } from "../errors/appError.js";
import { persistOperationIntent, reconcileOperationIntent } from "./operationIntentRepository.js";

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
  await persistOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    mutationKind: params.mutationKind,
    detail: params.detail,
  });

  try {
    const result = await params.mutate();
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "reconciled",
      publishRecordId: params.publishRecordId,
      detail: params.reconcileDetail,
    });
    return result;
  } catch (error) {
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "failed",
      detail: {
        ...params.reconcileDetail,
        errorMessage: error instanceof Error ? error.message : String(error),
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
