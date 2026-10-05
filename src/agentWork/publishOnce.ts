import * as postgresPublishStore from "./operationIntentRepository.js";
export { postgresPublishStore };
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { queryOne } from "../db/postgres.js";
import { logWarn } from "../evlog.js";
import { fencedWrite } from "./fencedWrite.js";
import { fenceForEpoch, type WriteFence } from "./writeFence.js";
import {
  ASK_PUBLISH_LENS,
  DESCRIPTION_PUBLISH_LENS,
  TRIAGE_PUBLISH_LENS,
  VERIFICATION_PUBLISH_LENS,
  type AnyReviewLens,
} from "../settings/index.js";
import { AppError, errorLogFields, isAppError, toAppError } from "../errors/appError.js";
import type { AppErrorCode } from "../errors/appErrorCodes.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { type OperationIntentRow } from "./operationIntentRepository.js";
import { findCompletedPublishRecordId } from "./reconcilePendingIntents.js";
import { assertPrActorLeaseHeld } from "./prActorLease.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import { httpStatus } from "../github/httpStatus.js";
import { errorMessage } from "../errors/errorMessage.js";

export type OperationIntentContext = {
  readonly client: Pool | PoolClient;
  readonly workItemId: string;
  readonly resourceKey: string;
  /** When set, mutate/publish is rejected unless this lease epoch still owns the work item. */
  readonly leaseEpoch?: number | null;
};

export type PublishIntentStore = Pick<
  typeof postgresPublishStore,
  | "persistOperationIntent"
  | "mergeOperationIntentDetail"
  | "reconcileOperationIntent"
  | "getOperationIntent"
  | "listPendingOperationIntents"
  | "findRetainedDescriptionSurfaceIdentity"
>;

export type PublishOnceParams<T> = {
  readonly store?: PublishIntentStore;
  readonly client: Pool | PoolClient;
  readonly workItemId: string;
  readonly operationKey: string;
  readonly mutationKind: string;
  readonly detail?: Record<string, unknown>;
  /** Selected attempt evidence; saved with the in-flight marker only after the owner permits delegation. */
  readonly mutationDetail?: Record<string, unknown>;
  readonly mutate: () => Promise<T>;
  /** Validate replayed evidence before exposing a typed mutation result. */
  readonly decodeResult?: (value: unknown) => T;
  readonly publishRecordId?: string | null;
  readonly reconcileDetail?: Record<string, unknown> | ((result: T) => Record<string, unknown>);
  /**
   * Reconcile a remote mutation by an exact marker or provider id. A missing
   * match is not permission to remutate an outcome-unknown operation.
   */
  readonly recover?: (
    intent: OperationIntentRow,
    publishRecordId: string | null,
  ) => Promise<OperationIntentRecovery<unknown>>;
  /**
   * True when `undefined` is a valid success (void mutate, or `T | undefined`).
   * Typed recoveries stay outcome_unknown when they cannot rebuild T.
   */
  readonly allowsUndefinedResult?: boolean;
  /** True only when the provider contract proves no mutation was accepted. */
  readonly isKnownNoAcceptanceError?: (error: unknown) => boolean;
  readonly leaseEpoch?: number | null;
  /** Required. Agrees with `leaseEpoch`: a number is a lease fence, null is unleased. */
  readonly fence: WriteFence;
  /** Aborted when the owning worker loses its lease or the job is cancelled. */
  readonly signal?: AbortSignal;
  /** Own-verdict delegation has a retryable local gate before any provider write. */
  readonly delegation?: { readonly resourceKey: string; readonly reviewLens: PublishLens };
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

export function reviewCommitStatusOperationKey(
  resourceKey: string,
  headSha: string,
  state: "pending" | "success" | "failure" | "error",
): string {
  return `review:commit_status:${resourceKey}:${headSha}:${state}`;
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
  params: PublishOnceParams<T>,
  result?: { readonly value: unknown },
): Record<string, unknown> {
  if (typeof params.reconcileDetail !== "function") return params.reconcileDetail ?? {};
  if (result === undefined) return {};
  if (params.decodeResult === undefined)
    throw new Error("A result-dependent reconciliation requires a result decoder");
  return params.reconcileDetail(
    decodePublishResult({ ...params, decodeResult: params.decodeResult }, result.value),
  );
}

function decodePublishResult<T>(
  params: PublishOnceParams<T> & { readonly decodeResult: (value: unknown) => T },
  value: unknown,
): T;
function decodePublishResult<T>(params: PublishOnceParams<T>, value: unknown): unknown;
function decodePublishResult<T>(params: PublishOnceParams<T>, value: unknown): unknown {
  if (params.decodeResult === undefined) return value;
  try {
    return params.decodeResult(value);
  } catch (error) {
    throw unknownOutcomeError(
      params,
      "Mutation result failed validation; remutate forbidden",
      true,
      error,
    );
  }
}

function isRemoteMutationError(error: unknown): boolean {
  if (httpStatus(error) != null) return true;
  if (typeof error !== "object" || error == null) return false;
  return "response" in error && typeof error.response === "object" && error.response != null;
}

function hasStashedResult(detail: Record<string, unknown>): boolean {
  return Object.hasOwn(detail, OPERATION_INTENT_RESULT_KEY);
}

function stashedResultValue(detail: Record<string, unknown>): unknown {
  // null is the durable sentinel for a successful void mutate() return.
  const value = detail[OPERATION_INTENT_RESULT_KEY];
  return value === null ? undefined : value;
}

function leaseEpochDetail<T>(
  params: PublishOnceParams<T>,
): { readonly leaseEpoch: number } | Record<string, never> {
  return params.leaseEpoch == null ? {} : { leaseEpoch: params.leaseEpoch };
}

function allowsUndefinedSuccess<T>(params: PublishOnceParams<T>): boolean {
  return params.allowsUndefinedResult === true || params.recover == null;
}

async function finishWithStashedResult<T>(
  params: PublishOnceParams<T>,
  intent: OperationIntentRow,
): Promise<unknown> {
  const value = decodePublishResult(params, stashedResultValue(intent.detail));
  if (intent.status !== "reconciled") {
    await assertMutationReady(params);
    await (params.store ?? postgresPublishStore).reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "reconciled",
      publishRecordId: params.publishRecordId,
      ...leaseEpochDetail(params),
      detail: {
        ...resolveReconcileDetail(params),
        [OPERATION_INTENT_RESULT_KEY]: intent.detail[OPERATION_INTENT_RESULT_KEY],
      },
    });
  }
  return value;
}

type RecoveryAttempt =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false };

async function recoverByExactEvidence<T>(
  params: PublishOnceParams<T>,
  intent: OperationIntentRow,
  publishRecordId: string | null,
): Promise<RecoveryAttempt> {
  if (params.recover == null) return { found: false };
  let recovery: OperationIntentRecovery<unknown>;
  try {
    recovery = await params.recover(intent, publishRecordId);
  } catch (error) {
    await assertMutationReady(params);
    throw new AppError({
      domain: "operation_intent",
      kind: "recovery_failed",
      message: "Failed to reconcile an outcome-unknown GitHub mutation",
      cause: error,
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
      },
    });
  }
  await assertMutationReady(params);
  if (recovery.kind !== "reconciled") return { found: false };
  const value = decodePublishResult(params, recovery.value);

  const resultDetail = {
    ...resolveReconcileDetail(params, { value }),
    ...recovery.detail,
    [OPERATION_INTENT_RESULT_KEY]: recovery.value === undefined ? null : recovery.value,
  };
  await (params.store ?? postgresPublishStore).reconcileOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    status: "reconciled",
    publishRecordId: recovery.publishRecordId ?? publishRecordId,
    ...leaseEpochDetail(params),
    detail: resultDetail,
  });
  return { found: true, value };
}

async function finishVoidSuccess<T>(
  params: PublishOnceParams<T>,
  extraDetail: Record<string, unknown>,
  publishRecordId?: string | null,
): Promise<unknown> {
  const value = decodePublishResult(params, undefined);
  await assertMutationReady(params);
  await (params.store ?? postgresPublishStore).reconcileOperationIntent(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    status: "reconciled",
    publishRecordId: publishRecordId ?? params.publishRecordId,
    ...leaseEpochDetail(params),
    detail: {
      ...resolveReconcileDetail(params),
      ...extraDetail,
      [OPERATION_INTENT_RESULT_KEY]: null,
    },
  });
  return value;
}

const UNKNOWN_MUTATION_MESSAGE =
  "Mutation outcome unknown after crash between mutate() and __result; remutate forbidden";

function unknownOutcomeError<T>(
  params: PublishOnceParams<T>,
  message: string,
  terminal: boolean,
  cause?: unknown,
): AppError {
  return new AppError({
    domain: "operation_intent",
    kind: "mutation_outcome_unknown",
    message,
    cause,
    context: {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      mutationKind: params.mutationKind,
      ...(terminal ? { unknownResolution: "terminal" } : {}),
    },
  });
}

async function recoverAfterMutatingWithoutResult<T>(
  params: PublishOnceParams<T>,
  intent: OperationIntentRow,
): Promise<unknown> {
  let publishRecordId: string | null;
  try {
    publishRecordId = await findCompletedPublishRecordId(params.client, params.workItemId, intent);
  } catch (error) {
    throw new AppError({
      domain: "operation_intent",
      kind: "publish_record_lookup_failed",
      message: "Failed to look up publish_records while recovering after __mutating",
      cause: error,
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
      },
    });
  }
  let recovered: RecoveryAttempt = { found: false };
  let observationError: AppError | undefined;
  try {
    recovered = await recoverByExactEvidence(params, intent, publishRecordId);
  } catch (error) {
    if (publishRecordId == null) throw error;
    if (!isAppError(error) || error.code !== "operation_intent.recovery_failed") throw error;
    observationError = error;
  }
  if (recovered.found) return recovered.value;

  // Publish-record success is void-only. A recover hook that cannot rebuild T
  // stays outcome_unknown so callers do not receive undefined as a typed result.
  if (publishRecordId != null && allowsUndefinedSuccess(params)) {
    return finishVoidSuccess(
      params,
      {
        reconciledFromPublishRecord: true,
        recoveredAfterMutating: true,
      },
      publishRecordId,
    );
  }
  await assertMutationReady(params);
  const resolved = await (params.store ?? postgresPublishStore).reconcileOperationIntent(
    params.client,
    {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      status: "outcome_unknown",
      ...leaseEpochDetail(params),
      detail: {
        ...resolveReconcileDetail(params),
        [OPERATION_INTENT_MUTATING_KEY]: false,
        ...(observationError == null ? { unknownResolution: "terminal" } : {}),
        errorCode: "operation_intent.mutation_outcome_unknown" satisfies AppErrorCode,
        errorMessage: UNKNOWN_MUTATION_MESSAGE,
      },
    },
  );
  if (resolved === null) {
    await assertMutationReady(params);
    throw new AppError({
      domain: "operation_intent",
      kind: "reconcile_no_row",
      message: "Unknown mutation resolution returned no row",
      context: { workItemId: params.workItemId, operationKey: params.operationKey },
    });
  }
  throw unknownOutcomeError(
    params,
    UNKNOWN_MUTATION_MESSAGE,
    observationError == null,
    observationError,
  );
}

/** Throw the abort reason as an AppError when the signal has fired. */
export function throwIfExecutionAborted(
  signal: AbortSignal | undefined,
  context: Record<string, unknown>,
): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (isAppError(reason)) throw reason;
  if (reason !== undefined) {
    throw toAppError(reason, { domain: "agent_work", kind: "execution_aborted", context });
  }
  throw new AppError({
    domain: "agent_work",
    kind: "execution_aborted",
    message: "PR-surface mutation was aborted before completion",
    context,
  });
}

async function assertMutationReady<T>(params: PublishOnceParams<T>): Promise<void> {
  throwIfExecutionAborted(params.signal, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
  });
  if (params.leaseEpoch != null) {
    await assertPrActorLeaseHeld(params.client, params.workItemId, params.leaseEpoch);
  }
}

/**
 * A retained description child keeps its original key and hash even when the
 * Config fields that built them are gone. Selection is scoped by work item,
 * parent scope, method, and exact marker; ambiguity fails closed.
 */
async function withRetainedDescriptionIdentity<T>(
  params: PublishOnceParams<T>,
): Promise<PublishOnceParams<T>> {
  if (
    params.mutationKind !== "github.pr_surface.publishDescription" ||
    params.detail?.surfaceMethod !== "publishDescription"
  )
    return params;
  await assertMutationReady(params);
  const retained = await (
    params.store ?? postgresPublishStore
  ).findRetainedDescriptionSurfaceIdentity(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    parentOperationKey:
      typeof params.detail.parentOperationKey === "string"
        ? params.detail.parentOperationKey
        : undefined,
    operationMarker:
      typeof params.detail.operationMarker === "string" ? params.detail.operationMarker : undefined,
  });
  if (retained == null) return params;
  return {
    ...params,
    operationKey: retained.operationKey,
    detail: { ...params.detail, inputHash: retained.inputHash },
  };
}

function assertFenceAgrees<T>(params: PublishOnceParams<T>): void {
  const fenceEpoch = params.fence.kind === "lease" ? params.fence.epoch : null;
  if (fenceEpoch !== (params.leaseEpoch ?? null)) {
    throw new Error("publish fence does not match leaseEpoch");
  }
}

export function publishOnce<T>(
  requested: PublishOnceParams<T> & { readonly decodeResult: (value: unknown) => T },
): Promise<T>;
export function publishOnce<T>(requested: PublishOnceParams<T>): Promise<unknown>;
export async function publishOnce<T>(requested: PublishOnceParams<T>): Promise<unknown> {
  assertFenceAgrees(requested);
  const params = await withRetainedDescriptionIdentity(requested);
  if (params.delegation == null)
    return runInOperationIntentFrame(params.operationKey, () => publishOnceBody(params));
  const parent = await (params.store ?? postgresPublishStore).persistOperationIntent(
    params.client,
    {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      mutationKind: params.mutationKind,
      leaseEpoch: params.leaseEpoch,
      detail: { ...params.delegation, delegationEntered: false },
    },
  );
  if (parent.status === "failed")
    await (params.store ?? postgresPublishStore).mergeOperationIntentDetail(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      leaseEpoch: params.leaseEpoch,
      detail: { delegationEntered: false, __mutating: false },
    });
  if (
    parent.status === "pending" &&
    parent.detail.__mutating === true &&
    parent.detail.delegationEntered === false &&
    !Object.hasOwn(parent.detail, "__result")
  ) {
    await (params.store ?? postgresPublishStore).reconcileOperationIntent(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      leaseEpoch: params.leaseEpoch,
      status: "failed",
      detail: { __mutating: false },
    });
  }
  return runInOperationIntentFrame(params.operationKey, () =>
    publishOnceBody({
      ...params,
      mutate: async () => {
        const marked = await (params.store ?? postgresPublishStore).mergeOperationIntentDetail(
          params.client,
          {
            workItemId: params.workItemId,
            operationKey: params.operationKey,
            leaseEpoch: params.leaseEpoch,
            detail: { delegationEntered: true },
          },
        );
        if (marked == null)
          throw new AppError({
            domain: "operation_intent",
            kind: "reconcile_no_row",
            message: "Own verdict delegation marker returned no row",
            context: { workItemId: params.workItemId },
          });
        return params.mutate();
      },
    }),
  );
}

async function publishOnceBody<T>(params: PublishOnceParams<T>): Promise<unknown> {
  await assertMutationReady(params);
  const intent = await (params.store ?? postgresPublishStore).persistOperationIntent(
    params.client,
    {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      mutationKind: params.mutationKind,
      ...leaseEpochDetail(params),
      detail: params.detail,
    },
  );
  await assertMutationReady(params);

  // Mutation outcome already stashed (reconciled, or crash/DB blip after mutate).
  // Never remutate when __result is present — finish status reconciliation only.
  if (hasStashedResult(intent.detail)) {
    return finishWithStashedResult(params, intent);
  }

  // A completed evidence decision stays fail-closed even if the worker died
  // before it could mark the owning work item failed.
  if (intent.status === "outcome_unknown" && intent.detail.unknownResolution === "terminal") {
    throw unknownOutcomeError(params, UNKNOWN_MUTATION_MESSAGE, true);
  }

  // Reconciled without a stashed return value (void mutate, or recovered
  // publish_records). Side effect is done — never remutate. If recover can
  // rebuild a typed result, stash it so later retries do not return undefined.
  if (intent.status === "reconciled") {
    const recovered = await recoverByExactEvidence(params, intent, null);
    if (recovered.found) return recovered.value;
    // Void-only. A typed recover that cannot rebuild T stays outcome_unknown.
    if (allowsUndefinedSuccess(params)) {
      return finishVoidSuccess(params, {}, intent.publishRecordId);
    }
    throw unknownOutcomeError(
      params,
      "Reconciled mutation has no stashed result and recover cannot rebuild it; remutate forbidden",
      true,
    );
  }

  // Crash between mutate() and __result: never auto-remutate. Resolve by evidence.
  if (intent.status === "outcome_unknown") {
    return recoverAfterMutatingWithoutResult(params, intent);
  }

  // A provider-proven pre-acceptance failure is the only retryable path.
  // Do not enter recovery — __mutating may still be present on older failed rows.
  if (intent.status !== "failed" && intent.detail[OPERATION_INTENT_MUTATING_KEY] === true) {
    return recoverAfterMutatingWithoutResult(params, intent);
  }

  await (params.store ?? postgresPublishStore).mergeOperationIntentDetail(params.client, {
    workItemId: params.workItemId,
    operationKey: params.operationKey,
    ...leaseEpochDetail(params),
    detail: {
      ...params.mutationDetail,
      [OPERATION_INTENT_MUTATING_KEY]: true,
    },
  });

  let mutateSucceeded = false;
  try {
    await assertMutationReady(params);
    const result = await params.mutate();
    mutateSucceeded = true;
    decodePublishResult(params, result);
    // A lease can be lost while GitHub is processing the request. Do not let a
    // stale worker persist completion after that ambiguous remote outcome.
    await assertMutationReady(params);
    // Always stash __result (null = void) so redelivery is idempotent without remutate.
    const resultDetail = {
      ...resolveReconcileDetail(params, { value: result }),
      [OPERATION_INTENT_RESULT_KEY]: result === undefined ? null : result,
    };
    await (params.store ?? postgresPublishStore).mergeOperationIntentDetail(params.client, {
      workItemId: params.workItemId,
      operationKey: params.operationKey,
      ...leaseEpochDetail(params),
      detail: resultDetail,
    });
    await (params.store ?? postgresPublishStore).reconcileOperationIntent(params.client, {
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
        const intentForRecovery = await (
          params.store ?? postgresPublishStore
        ).persistOperationIntent(params.client, {
          workItemId: params.workItemId,
          operationKey: params.operationKey,
          mutationKind: params.mutationKind,
          ...leaseEpochDetail(params),
          detail: params.detail,
        });
        const recovered = await recoverByExactEvidence(params, intentForRecovery, null);
        if (recovered.found) return recovered.value;
      }
      await (params.store ?? postgresPublishStore).reconcileOperationIntent(params.client, {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        status: knownNoAcceptance ? "failed" : "outcome_unknown",
        ...leaseEpochDetail(params),
        detail: {
          ...resolveReconcileDetail(params),
          // Clear marker only when the provider proved that no mutation landed.
          [OPERATION_INTENT_MUTATING_KEY]: false,
          errorCode: knownNoAcceptance
            ? ("operation_intent.mutation_failed" satisfies AppErrorCode)
            : ("operation_intent.mutation_outcome_unknown" satisfies AppErrorCode),
          errorMessage: sanitizeLogMessage(errorMessage(error)),
        },
      });
    }
    if (isAppError(error)) throw error;
    throw toAppError(error, {
      domain: "operation_intent",
      kind: !mutateSucceeded && knownNoAcceptance ? "mutation_failed" : "mutation_outcome_unknown",
      context: {
        workItemId: params.workItemId,
        operationKey: params.operationKey,
        mutationKind: params.mutationKind,
      },
    });
  }
}

export type PublishLens =
  | AnyReviewLens
  | typeof DESCRIPTION_PUBLISH_LENS
  | typeof ASK_PUBLISH_LENS
  | typeof TRIAGE_PUBLISH_LENS
  | typeof VERIFICATION_PUBLISH_LENS;
type SharedPublishLens = Exclude<PublishLens, typeof ASK_PUBLISH_LENS>;
export type PublishStep = keyof typeof publishStepSpecs;
type SharedPublishStep = Exclude<PublishStep, "ask_reply" | "check_run">;
type AskPublishStep = Extract<PublishStep, "ask_reply">;

async function getLatestCompletedPublishStepDetail(
  pool: Pool | PoolClient,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ detail: Record<string, unknown> | null }>(
    pool,
    `SELECT detail
		   FROM publish_records
		  WHERE resource_key = $1
		    AND review_lens = $2
		    AND step = $3
		    AND status = 'completed'
		  ORDER BY updated_at DESC
		  LIMIT 1`,
    [resourceKey, reviewLens, step],
  );
  return row?.detail ?? null;
}

async function getCompletedPublishStepDetail(
  pool: Pool | PoolClient,
  workItemId: string,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ detail: Record<string, unknown> | null }>(
    pool,
    `SELECT detail
		   FROM publish_records
		  WHERE work_item_id = $1
		    AND resource_key = $2
		    AND review_lens = $3
		    AND step = $4
		    AND status = 'completed'
		  LIMIT 1`,
    [workItemId, resourceKey, reviewLens, step],
  );
  return row?.detail ?? null;
}

async function getCompletedPublishStepDetailWithoutNewerStep(
  pool: Pool | PoolClient,
  resourceKey: string,
  reviewLens: PublishLens,
  step: PublishStep,
  newerStep: PublishStep,
): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ detail: Record<string, unknown> | null }>(
    pool,
    `SELECT current_step.detail
       FROM publish_records current_step
      WHERE current_step.resource_key = $1
        AND current_step.review_lens = $2
        AND current_step.step = $3
        AND current_step.status = 'completed'
        AND NOT EXISTS (
          SELECT 1
            FROM publish_records newer_step
           WHERE newer_step.resource_key = current_step.resource_key
             AND newer_step.review_lens = current_step.review_lens
             AND newer_step.step = $4
             AND newer_step.status = 'completed'
             AND newer_step.updated_at >= current_step.updated_at
        )
      ORDER BY current_step.updated_at DESC
      LIMIT 1`,
    [resourceKey, reviewLens, step, newerStep],
  );
  return row?.detail ?? null;
}

async function recordPublishStep(
  pool: Pool | PoolClient,
  params: {
    workItemId: string;
    resourceKey: string;
    reviewLens: SharedPublishLens;
    step: SharedPublishStep;
    githubId?: string | number;
    detail?: Record<string, unknown>;
    /**
     * Lease epoch that owns this write. Pass `null` only for unleased writers
     * (e.g. ack progress stubs, ask); leased executors must pass the live epoch.
     */
    leaseEpoch: number | null;
  },
): Promise<void> {
  const detail =
    publishStepSpecs[params.step].merge === "batches" && typeof params.detail?.batchId === "string"
      ? { batches: [params.detail] }
      : (params.detail ?? {});
  const result = await fencedWrite(
    pool,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      pool.query(
        `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, lease_epoch, detail)
         SELECT $1, $2, $3, $4, $5, $6, 'completed', $7, $8::jsonb
          WHERE $7::bigint IS NULL OR EXISTS (
            SELECT 1 FROM pr_actor_leases
             WHERE work_item_id = $2 AND lease_epoch = $7
          )
					 ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'
				 DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
				               github_id = EXCLUDED.github_id,
				               status = 'completed',
				               lease_epoch = COALESCE(EXCLUDED.lease_epoch, publish_records.lease_epoch),
			               detail = CASE
			                 WHEN EXCLUDED.step = 'inline_review'
			                      AND jsonb_typeof(EXCLUDED.detail->'batches') = 'array'
			                 THEN jsonb_set(
			                   COALESCE(publish_records.detail, '{}'::jsonb),
			                   '{batches}',
			                   CASE
			                     WHEN COALESCE(publish_records.detail->'batches', '[]'::jsonb) @>
			                          jsonb_build_array(jsonb_build_object(
			                            'batchId', EXCLUDED.detail #>> '{batches,0,batchId}'
			                          ))
			                     THEN COALESCE(publish_records.detail->'batches', '[]'::jsonb)
			                     ELSE COALESCE(publish_records.detail->'batches', '[]'::jsonb) ||
			                          (EXCLUDED.detail->'batches')
			                   END,
			                   true
			                 )
			                 WHEN EXCLUDED.step = 'progress_comment'
			                 THEN COALESCE(publish_records.detail, '{}'::jsonb) || EXCLUDED.detail
			                 ELSE EXCLUDED.detail
			               END,
				               updated_at = now()
				         WHERE (publish_records.step <> 'progress_comment'
				            OR publish_records.work_item_id = EXCLUDED.work_item_id)
				           AND (EXCLUDED.lease_epoch IS NULL OR EXISTS (
				             SELECT 1 FROM pr_actor_leases
				              WHERE work_item_id = EXCLUDED.work_item_id
				                AND lease_epoch = EXCLUDED.lease_epoch
				           ))`,
        [
          crypto.randomUUID(),
          params.workItemId,
          params.resourceKey,
          params.reviewLens,
          params.step,
          params.githubId == null ? null : String(params.githubId),
          params.leaseEpoch,
          JSON.stringify(detail),
        ],
      ),
  );
  if ((result.rowCount ?? 0) === 0 && params.step === "progress_comment") {
    const error = new AppError({
      domain: "agent_work",
      kind: "progress_comment_ownership_conflict",
      message: "Progress comment publish record was rejected by its ownership gate",
      context: {
        workItemId: params.workItemId,
        resourceKey: params.resourceKey,
        reviewLens: params.reviewLens,
        leaseEpoch: params.leaseEpoch,
        rowCount: result.rowCount ?? 0,
        ...(params.githubId != null ? { githubId: params.githubId } : {}),
      },
    });
    logWarn("review_progress_publish_record_conflict", errorLogFields(error));
    throw error;
  }
}

async function recordAskPublishStep(
  pool: Pool | PoolClient,
  params: {
    workItemId: string;
    resourceKey: string;
    step: AskPublishStep;
    githubId?: string | number;
    detail?: Record<string, unknown>;
    leaseEpoch: number | null;
  },
): Promise<void> {
  await fencedWrite(
    pool,
    params.workItemId,
    params.leaseEpoch,
    { before: true, rejected: (written) => (written.rowCount ?? 0) === 0 },
    () =>
      pool.query(
        `INSERT INTO publish_records (id, work_item_id, resource_key, review_lens, step, github_id, status, lease_epoch, detail)
         SELECT $1, $2, $3, $4, $5, $6, 'completed', $7, $8::jsonb
          WHERE $7::bigint IS NULL OR EXISTS (
            SELECT 1 FROM pr_actor_leases
             WHERE work_item_id = $2 AND lease_epoch = $7
          )
				 ON CONFLICT (work_item_id, review_lens, step) WHERE review_lens = 'ask'
				 DO UPDATE SET resource_key = EXCLUDED.resource_key,
				               github_id = EXCLUDED.github_id,
				               status = 'completed',
				               lease_epoch = COALESCE(EXCLUDED.lease_epoch, publish_records.lease_epoch),
				               detail = EXCLUDED.detail,
			               updated_at = now()`,
        [
          crypto.randomUUID(),
          params.workItemId,
          params.resourceKey,
          ASK_PUBLISH_LENS,
          params.step,
          params.githubId == null ? null : String(params.githubId),
          params.leaseEpoch,
          JSON.stringify(params.detail ?? {}),
        ],
      ),
  );
}

/** Persisted identities and their completion scope. Check creation has a separate CAS owner. */
export const publishStepSpecs = {
  progress_comment: { scope: "resource", merge: "progress" },
  inline_review: { scope: "resource", merge: "batches" },
  summary_comment: { scope: "resource", merge: "replace" },
  summary_comment_claim: { scope: "resource", merge: "replace" },
  check_run: { scope: "work", merge: "replace" },
  labels: { scope: "resource", merge: "replace" },
  pr_body: { scope: "resource", merge: "replace" },
  ask_reply: { scope: "work", merge: "replace" },
  triage_push: { scope: "resource", merge: "replace" },
  triage_thread_actions: { scope: "resource", merge: "replace" },
  triage_report: { scope: "resource", merge: "replace" },
  triage_preview: { scope: "resource", merge: "replace" },
  verification_thread_actions: { scope: "resource", merge: "replace" },
  ci_cell: { scope: "resource", merge: "replace" },
  commit_status: { scope: "resource", merge: "replace" },
  verification_failure: { scope: "resource", merge: "replace" },
} as const satisfies Record<string, PublishStepSpec>;

export type PublishStepSpec = {
  readonly scope: "resource" | "work";
  readonly merge: "progress" | "batches" | "replace";
};

export type CompletionRecord = {
  readonly step: Exclude<PublishStep, "check_run">;
  readonly githubId?: string | number;
  readonly detail?: Record<string, unknown>;
};
export type PublicationIdentity = {
  readonly workItemId?: string;
  readonly resourceKey: string;
  readonly reviewLens: PublishLens;
  readonly leaseEpoch?: number | null;
  readonly store?: PublishIntentStore;
} & Partial<CompletionRecord>;

export type PublishRecordStore = {
  readonly completed: typeof getCompletedPublishStepDetail;
  readonly latest: typeof getLatestCompletedPublishStepDetail;
  readonly withoutNewer: typeof getCompletedPublishStepDetailWithoutNewerStep;
  readonly write: (
    client: Pool | PoolClient,
    identity: PublicationIdentity &
      CompletionRecord & { readonly workItemId: string; readonly leaseEpoch: number | null },
  ) => Promise<void>;
};

export const postgresPublishRecords: PublishRecordStore = {
  completed: getCompletedPublishStepDetail,
  latest: getLatestCompletedPublishStepDetail,
  withoutNewer: getCompletedPublishStepDetailWithoutNewerStep,
  write: async (client, identity) => {
    if (identity.step === "ask_reply") {
      if (identity.reviewLens !== ASK_PUBLISH_LENS)
        throw new AppError({
          domain: "agent_work",
          kind: "publish_lens_mismatch",
          message: "Ask completion requires the ask lens",
        });
      await recordAskPublishStep(client, { ...identity, step: identity.step });
    } else {
      if (identity.reviewLens === ASK_PUBLISH_LENS)
        throw new AppError({
          domain: "agent_work",
          kind: "publish_lens_mismatch",
          message: "Shared completion cannot use the ask lens",
        });
      await recordPublishStep(client, {
        ...identity,
        step: identity.step,
        reviewLens: identity.reviewLens,
      });
    }
  },
};

/** One scoped owner for completion evidence, records, and thread checkpoints. */
export function createPublishContext(
  client: Pool | PoolClient,
  identity: PublicationIdentity,
  records: PublishRecordStore = postgresPublishRecords,
) {
  const workItemId = () => {
    if (identity.workItemId == null)
      throw new AppError({
        domain: "agent_work",
        kind: "publish_owner_missing",
        message: "Publication requires a work-item owner",
      });
    return identity.workItemId;
  };
  const completed = (step: PublishStep) =>
    records.completed(client, workItemId(), identity.resourceKey, identity.reviewLens, step);
  const record = async (input?: CompletionRecord): Promise<void> => {
    const value = input ?? identity;
    if (value.step == null)
      throw new AppError({
        domain: "agent_work",
        kind: "publish_owner_missing",
        message: "Publication requires a step",
      });
    const spec = publishStepSpecs[value.step];
    if (spec == null || identity.leaseEpoch === undefined)
      throw new AppError({
        domain: "agent_work",
        kind: "publish_owner_missing",
        message: "Publication requires a step and explicit lease epoch",
      });
    await records.write(client, {
      ...identity,
      ...value,
      step: value.step,
      workItemId: workItemId(),
      leaseEpoch: identity.leaseEpoch,
    });
  };
  return {
    completed,
    intent: (operationKey: string) =>
      (identity.store ?? postgresPublishStore).getOperationIntent(
        client,
        workItemId(),
        operationKey,
      ),
    once: <T>(
      params: Omit<
        PublishOnceParams<T>,
        "client" | "workItemId" | "leaseEpoch" | "fence" | "store"
      >,
    ) =>
      publishOnce({
        ...params,
        client,
        workItemId: workItemId(),
        leaseEpoch: identity.leaseEpoch,
        fence: fenceForEpoch(identity.leaseEpoch),
        store: identity.store,
      }),
    failClosed: async (intent: OperationIntentRow): Promise<never> => {
      const params = {
        client,
        workItemId: workItemId(),
        operationKey: intent.operationKey,
        mutationKind: intent.mutationKind,
        leaseEpoch: identity.leaseEpoch,
        fence: fenceForEpoch(identity.leaseEpoch),
        store: identity.store,
        mutate: async () => undefined,
      };
      await assertMutationReady(params);
      if (intent.detail.unknownResolution === "terminal")
        throw unknownOutcomeError(params, UNKNOWN_MUTATION_MESSAGE, true);
      const resolved = await (identity.store ?? postgresPublishStore).reconcileOperationIntent(
        client,
        {
          workItemId: workItemId(),
          operationKey: intent.operationKey,
          leaseEpoch: identity.leaseEpoch,
          status: "outcome_unknown",
          detail: {
            __mutating: false,
            unknownResolution: "terminal",
            errorCode: "operation_intent.mutation_outcome_unknown" satisfies AppErrorCode,
            errorMessage: UNKNOWN_MUTATION_MESSAGE,
          },
        },
      );
      if (resolved == null) {
        await assertMutationReady(params);
        throw new AppError({
          domain: "operation_intent",
          kind: "reconcile_no_row",
          message: "Unknown mutation resolution returned no row",
          context: { workItemId: workItemId(), operationKey: intent.operationKey },
        });
      }
      throw unknownOutcomeError(params, UNKNOWN_MUTATION_MESSAGE, true);
    },
    adopt: async (params: {
      readonly operationKey: string;
      readonly mutationKind: string;
      readonly result: unknown;
      readonly detail: Record<string, unknown>;
      readonly hasUsableResult: (detail: Record<string, unknown>) => boolean;
    }): Promise<void> => {
      const intent = await (identity.store ?? postgresPublishStore).getOperationIntent(
        client,
        workItemId(),
        params.operationKey,
      );
      if (intent == null) {
        await (identity.store ?? postgresPublishStore).persistOperationIntent(client, {
          workItemId: workItemId(),
          operationKey: params.operationKey,
          mutationKind: params.mutationKind,
          detail: {
            step: identity.step,
            resourceKey: identity.resourceKey,
            reviewLens: identity.reviewLens,
            ...params.detail,
            __result: params.result,
          },
        });
        return;
      }
      if (params.hasUsableResult(intent.detail)) return;
      if (intent.status === "outcome_unknown") {
        await (identity.store ?? postgresPublishStore).reconcileOperationIntent(client, {
          workItemId: workItemId(),
          operationKey: params.operationKey,
          status: "reconciled",
          detail: { __result: params.result, ...params.detail, recoveredAfterMutating: true },
        });
        return;
      }
      if (intent.status === "pending")
        await (identity.store ?? postgresPublishStore).mergeOperationIntentDetail(client, {
          workItemId: workItemId(),
          operationKey: params.operationKey,
          detail: { __result: params.result, ...params.detail },
        });
    },
    latest: (step: PublishStep) =>
      records.latest(client, identity.resourceKey, identity.reviewLens, step),
    withoutNewer: (step: PublishStep, newerStep: PublishStep) =>
      records.withoutNewer(client, identity.resourceKey, identity.reviewLens, step, newerStep),
    record,
    actedThreads: async (step: "triage_thread_actions" | "verification_thread_actions") => {
      const detail = await completed(step);
      const ids = detail?.actedThreadIds;
      return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : [];
    },
    recordActedThreads: (
      step: "triage_thread_actions" | "verification_thread_actions",
      actedThreadIds: readonly number[],
    ) => record({ step, detail: { actedThreadIds } }),
  };
}
