import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError, isAppError, toAppError } from "../errors/appError.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import {
  mergeOperationIntentDetail,
  persistOperationIntent,
  reconcileOperationIntent,
  type OperationIntentRow,
} from "./operationIntentRepository.js";
import { findCompletedPublishRecordId } from "./reconcilePendingIntents.js";
import { assertPrActorLeaseHeld } from "./prActorLease.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import { httpStatus } from "../github/httpStatus.js";

export type OperationIntentContext = {
  readonly client: Pool | PoolClient;
  readonly workItemId: string;
  readonly resourceKey: string;
  /** When set, mutate/publish is rejected unless this lease epoch still owns the work item. */
  readonly leaseEpoch?: number | null;
};

export type WithOperationIntentParams<T> = {
  readonly client: Pool | PoolClient;
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly detail?: Record<string, unknown>;
  readonly mutate: () => Promise<T>;
  readonly publishRecordId?: string | null;
  readonly reconcileDetail?: Record<string, unknown> | ((result: T) => Record<string, unknown>);
  /**
   * Reconcile a remote mutation by an exact marker or provider id. A missing
   * match is not permission to remutate an outcome-unknown operation.
   */
  readonly recover?: (
    intent: OperationIntentRow,
    publishRecordId: string | null,
  ) => Promise<OperationIntentRecovery<T>>;
  /** True only when the provider contract proves no mutation was accepted. */
  readonly isKnownNoAcceptanceError?: (error: unknown) => boolean;
  readonly leaseEpoch?: number | null;
  /** Aborted when the owning worker loses its lease or the job is cancelled. */
  readonly signal?: AbortSignal;
};

const operationIntentFrame = new AsyncLocalStorage<{ readonly operationKey: string }>();

/** Run work as the current operation-intent key so nested PR-surface mutations share it. */
export function runInOperationIntentFrame<T>(operationKey: string, fn: () => T): T {
  return operationIntentFrame.run({ operationKey }, fn);
}

export function currentOperationIntentKey(): string | undefined {
  return operationIntentFrame.getStore()?.operationKey;
}

export type OperationIntentRecovery<T> =
  | {
      readonly kind: "reconciled";
      readonly value: T;
      readonly publishRecordId?: string | null;
      readonly detail?: Record<string, unknown>;
    }
  | { readonly kind: "absent" };

/** Durable marker: mutate() was entered; crash before __result must not remutate. */
export const OPERATION_INTENT_MUTATING_KEY = "__mutating";
export const OPERATION_INTENT_RESULT_KEY = "__result";

export function askReplyOperationKey(resourceKey: string, targetCommentId?: number): string {
  return targetCommentId == null
    ? `ask:reply:${resourceKey}`
    : `ask:reply:${resourceKey}:${targetCommentId}`;
}

export function askFailureReplyOperationKey(resourceKey: string, targetCommentId?: number): string {
  return targetCommentId == null
    ? `ask:failure_reply:${resourceKey}`
    : `ask:failure_reply:${resourceKey}:${targetCommentId}`;
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
    ...params.findingFingerprints.toSorted(),
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

export function triagePreviewOperationKey(resourceKey: string): string {
  return `triage:preview:${resourceKey}`;
}

export function verificationThreadOperationKey(rootCommentId: number): string {
  return `verification:thread:${rootCommentId}`;
}

export function verificationFailureOperationKey(headSha: string): string {
  return `verification:failure:${headSha}`;
}

export function reviewCheckOperationKey(workItemId: string): string {
  return `review:check_run:${workItemId}`;
}

export function reviewCommitStatusOperationKey(resourceKey: string, headSha: string): string {
  return `review:commit_status:${resourceKey}:${headSha}`;
}

export function reviewLabelsOperationKey(resourceKey: string): string {
  return `review:labels:${resourceKey}`;
}

/** Stable hidden marker for reconciling one provider-side mutation attempt. */
export function operationIntentMarker(operationKey: string, operationInstance: string): string {
  return `<!-- pr-agent:operation-intent ${crypto
    .createHash("sha256")
    .update(`${operationKey}\0${operationInstance}`)
    .digest("hex")
    .slice(0, 24)} -->`;
}

function resolveReconcileDetail<T>(
  params: WithOperationIntentParams<T>,
  result: T,
  hasResult: boolean,
): Record<string, unknown> {
  if (!hasResult && typeof params.reconcileDetail === "function") return {};
  return typeof params.reconcileDetail === "function"
    ? params.reconcileDetail(result)
    : (params.reconcileDetail ?? {});
}

function isRemoteMutationError(error: unknown): boolean {
  if (httpStatus(error) != null) return true;
  if (typeof error !== "object" || error == null) return false;
  const value = error as Record<string, unknown>;
  return typeof value.response === "object" && value.response != null;
}

function hasStashedResult(detail: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(detail, OPERATION_INTENT_RESULT_KEY);
}

function stashedResultValue(detail: Record<string, unknown>): unknown {
  // null is the durable sentinel for a successful void mutate() return.
  const value = detail[OPERATION_INTENT_RESULT_KEY];
  return value === null ? undefined : value;
}

function leaseEpochDetail<T>(
  params: WithOperationIntentParams<T>,
): { readonly leaseEpoch: number } | Record<string, never> {
  return params.leaseEpoch == null ? {} : { leaseEpoch: params.leaseEpoch };
}

async function finishWithStashedResult<T>(
  params: WithOperationIntentParams<T>,
  intent: OperationIntentRow,
): Promise<T> {
  if (intent.status !== "reconciled") {
    await assertMutationReady(params);
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "reconciled",
      publishRecordId: params.publishRecordId,
      ...leaseEpochDetail(params),
      detail: {
        ...resolveReconcileDetail(params, undefined as T, false),
        [OPERATION_INTENT_RESULT_KEY]: intent.detail[OPERATION_INTENT_RESULT_KEY],
      },
    });
  }
  return stashedResultValue(intent.detail) as T;
}

type RecoveryAttempt<T> = { readonly found: true; readonly value: T } | { readonly found: false };

async function recoverByExactEvidence<T>(
  params: WithOperationIntentParams<T>,
  intent: OperationIntentRow,
  publishRecordId: string | null,
): Promise<RecoveryAttempt<T>> {
  if (params.recover == null || publishRecordId != null) return { found: false };
  let recovery: OperationIntentRecovery<T>;
  try {
    recovery = await params.recover(intent, publishRecordId);
  } catch (error) {
    throw new AppError({
      code: "operation_intent.recovery_failed",
      message: "Failed to reconcile an outcome-unknown GitHub mutation",
      cause: error,
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
      },
    });
  }
  if (recovery.kind !== "reconciled") return { found: false };

  const resultDetail = {
    ...resolveReconcileDetail(params, recovery.value, true),
    ...recovery.detail,
    [OPERATION_INTENT_RESULT_KEY]:
      recovery.value === undefined ? null : (recovery.value as unknown),
  };
  await reconcileOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    status: "reconciled",
    publishRecordId: recovery.publishRecordId,
    ...leaseEpochDetail(params),
    detail: resultDetail,
  });
  return { found: true, value: recovery.value };
}

async function recoverAfterMutatingWithoutResult<T>(
  params: WithOperationIntentParams<T>,
  intent: OperationIntentRow,
): Promise<T> {
  let publishRecordId: string | null;
  try {
    publishRecordId = await findCompletedPublishRecordId(params.client, params.workItemId, intent);
  } catch (error) {
    throw new AppError({
      code: "operation_intent.publish_record_lookup_failed",
      message: "Failed to look up publish_records while recovering after __mutating",
      cause: error,
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
      },
    });
  }
  if (publishRecordId != null) {
    await assertMutationReady(params);
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "reconciled",
      publishRecordId,
      ...leaseEpochDetail(params),
      detail: {
        ...resolveReconcileDetail(params, undefined as T, false),
        reconciledFromPublishRecord: true,
        recoveredAfterMutating: true,
      },
    });
    throw new AppError({
      code: "operation_intent.mutation_outcome_unknown",
      message:
        "Mutation side effect already present in publish_records; refusing remutate after __mutating without stashed __result",
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
        publishRecordId,
      },
    });
  }

  const recovered = await recoverByExactEvidence(params, intent, null);
  if (recovered.found) return recovered.value;
  await assertMutationReady(params);
  await reconcileOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    status: "outcome_unknown",
    ...leaseEpochDetail(params),
    detail: {
      ...resolveReconcileDetail(params, undefined as T, false),
      [OPERATION_INTENT_MUTATING_KEY]: false,
      errorCode: "operation_intent.mutation_outcome_unknown",
      errorMessage:
        "Mutation outcome unknown after crash between mutate() and __result; remutate forbidden",
    },
  });
  throw new AppError({
    code: "operation_intent.mutation_outcome_unknown",
    message:
      "Mutation outcome unknown after crash between mutate() and __result; remutate forbidden",
    context: {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      mutationKind: params.mutationKind,
    },
  });
}

async function assertMutationReady<T>(params: WithOperationIntentParams<T>): Promise<void> {
  if (params.signal?.aborted) {
    const reason = params.signal.reason;
    if (isAppError(reason)) throw reason;
    if (reason !== undefined) {
      throw toAppError(reason, {
        code: "agent_work.execution_aborted",
        context: { workItemId: params.workItemId, operationKey: params.operationKey },
      });
    }
    throw new AppError({
      code: "agent_work.execution_aborted",
      message: "PR-surface mutation was aborted before completion",
      context: { workItemId: params.workItemId, operationKey: params.operationKey },
    });
  }
  if (params.leaseEpoch != null) {
    await assertPrActorLeaseHeld(params.client, params.workItemId, params.leaseEpoch);
  }
}

export async function withOperationIntent<T>(params: WithOperationIntentParams<T>): Promise<T> {
  return runInOperationIntentFrame(params.operationKey, () => withOperationIntentBody(params));
}

async function withOperationIntentBody<T>(params: WithOperationIntentParams<T>): Promise<T> {
  await assertMutationReady(params);
  const intent = await persistOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    mutationKind: params.mutationKind,
    ...leaseEpochDetail(params),
    detail: params.detail,
  });
  await assertMutationReady(params);

  // Mutation outcome already stashed (reconciled, or crash/DB blip after mutate).
  // Never remutate when __result is present — finish status reconciliation only.
  if (hasStashedResult(intent.detail)) {
    return finishWithStashedResult(params, intent);
  }

  // Reconciled without a stashed return value (void mutate, or recovered
  // publish_records). Side effect is done — never remutate. If recover can
  // rebuild a typed result, stash it so later retries do not return undefined.
  if (intent.status === "reconciled") {
    const recovered = await recoverByExactEvidence(params, intent, null);
    if (recovered.found) return recovered.value;
    return undefined as T;
  }

  // Crash between mutate() and __result: never auto-remutate. Resolve by evidence.
  if (intent.status === "outcome_unknown") {
    return recoverAfterMutatingWithoutResult(params, intent);
  }

  // A provider-proven pre-acceptance failure is the only retryable path.
  // Do not enter recovery — __mutating may still be present on older failed rows.
  if (intent.status === "failed") {
    // fall through to remutate
  } else if (intent.detail[OPERATION_INTENT_MUTATING_KEY] === true) {
    return recoverAfterMutatingWithoutResult(params, intent);
  }

  await mergeOperationIntentDetail(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    ...leaseEpochDetail(params),
    detail: {
      [OPERATION_INTENT_MUTATING_KEY]: true,
    },
  });

  let mutateSucceeded = false;
  try {
    await assertMutationReady(params);
    const result = await params.mutate();
    mutateSucceeded = true;
    // A lease can be lost while GitHub is processing the request. Do not let a
    // stale worker persist completion after that ambiguous remote outcome.
    await assertMutationReady(params);
    // Always stash __result (null = void) so redelivery is idempotent without remutate.
    const resultDetail = {
      ...resolveReconcileDetail(params, result, true),
      [OPERATION_INTENT_RESULT_KEY]: result === undefined ? null : (result as unknown),
    };
    await mergeOperationIntentDetail(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      ...leaseEpochDetail(params),
      detail: resultDetail,
    });
    await reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "reconciled",
      publishRecordId: params.publishRecordId,
      ...leaseEpochDetail(params),
      detail: resultDetail,
    });
    return result;
  } catch (error) {
    // After mutate() returns, never mark failed — leave __mutating so redelivery
    // takes the no-remutate recovery path instead of calling mutate() again.
    const knownNoAcceptance =
      params.isKnownNoAcceptanceError?.(error) ?? isKnownNoAcceptanceMutationError(error);
    if (!mutateSucceeded) {
      if (!knownNoAcceptance && (params.recover != null || isRemoteMutationError(error))) {
        const intentForRecovery = await persistOperationIntent(params.client, {
          workItemId: params.workItemId,
          operationKey: params.operationKey,
          mutationKind: params.mutationKind,
          detail: params.detail,
        });
        const recovered = await recoverByExactEvidence(params, intentForRecovery, null);
        if (recovered.found) return recovered.value;
      }
      await reconcileOperationIntent(params.client, {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        status: knownNoAcceptance ? "failed" : "outcome_unknown",
        ...leaseEpochDetail(params),
        detail: {
          ...resolveReconcileDetail(params, undefined as T, false),
          // Clear marker only when the provider proved that no mutation landed.
          [OPERATION_INTENT_MUTATING_KEY]: false,
          errorCode: knownNoAcceptance
            ? "operation_intent.mutation_failed"
            : "operation_intent.mutation_outcome_unknown",
          errorMessage: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
        },
      });
    }
    if (isAppError(error)) throw error;
    throw toAppError(error, {
      code:
        mutateSucceeded ||
        (!knownNoAcceptance && (params.recover != null || isRemoteMutationError(error)))
          ? "operation_intent.mutation_outcome_unknown"
          : knownNoAcceptance
            ? "operation_intent.mutation_failed"
            : "operation_intent.mutation_outcome_unknown",
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
