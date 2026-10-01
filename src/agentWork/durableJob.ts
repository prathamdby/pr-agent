import os from "node:os";
import type { JobWithMetadata } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import {
  captureWorkRetried,
  durationMsFromClaim,
  workFailureReasonFromClassified,
} from "../analytics/workCompleted.js";
import { captureDurableWorkCompletedWithCi } from "./ciWorkTelemetry.js";
import { AppError, errorLogFields, isAppError } from "../errors/appError.js";
import { logError, logInfo, logWarn } from "../evlog.js";
import { getAppBotIdentity, type BotIdentity, type InstallationToken } from "../github/appAuth.js";
import {
  clearInstallationTokenCacheForTest,
  mintInstallationToken,
} from "../github/installationToken.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import { classifyProviderError, isCancelAbortError } from "../agent/providers/providerErrors.js";
import { classifyFailure, classifiedFailureLogFields } from "../errors/classifiedFailure.js";
import type { PullRequestForFileList } from "../github/listPullRequestFiles.js";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  REVIEW_CANCEL_POLL_INTERVAL_MS,
  type GithubReactionContent,
} from "../settings/index.js";
import {
  claimWorkForExecution,
  forceMarkRescheduledParentCompleted,
  type WorkClaim,
  getWorkItem,
  getWorkItemCore,
  getWorkItemPayload,
  markWorkCancelled,
  markWorkCompleted,
  markWorkFailed,
  markWorkPublishDegraded,
  markWorkRetrying,
  shouldSkipWork,
  updateRunningWorkHeadSha,
} from "./repository.js";
import {
  acquirePrActorLease,
  armLeaseWatchdogHop,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  releasePrActorLease,
  renewPrActorLease,
  type PrActorLeaseKey,
} from "./prActorLease.js";
import {
  createPrSurface,
  type PrSurface,
  type PrSurfaceMutation,
  type PrSurfaceMutationBoundary,
} from "../github/prSurface.js";
import { reactionTargetsForWorkItem } from "./reactionTargets.js";
import { cancelOrphanedStaleHeadReplacementOnTerminalFailure } from "./reviewReschedule.js";
import {
  escalationForAttempt,
  maxAttempts,
  retryDispositionFor,
  type EscalationPlan,
  type RetryDisposition,
} from "./retryPolicy.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkType } from "./types.js";
import { inTransaction } from "../db/postgres.js";
import { installationGroupId, isWorkItemType } from "./types.js";
import { attachWorkItemPayload } from "./workItemPayloadSchema.js";
import { reconcilePendingIntents } from "./reconcilePendingIntents.js";
import { withOperationIntent, type WithOperationIntentParams } from "./withOperationIntent.js";
import { clearResumeSnapshotsBestEffort } from "../agent/runtime/sessionDurability.js";

export type DurableExecutionContext = {
  prSurface: PrSurface;
  headSha: string;
  pullRequest?: PullRequestForFileList;
  /** Fencing token of the PR actor lease owning this execution; null for unleased work types. */
  leaseEpoch: number | null;
  /** Combined job/lease signal; aborted when the worker is stopped, cancelled, or fenced. */
  signal: AbortSignal;
  /** Durable claim timestamps and attempt count from the claim write. */
  claim?: WorkClaim;
  /** Deterministic escalation for this attempt; undefined on attempt 1. */
  escalation?: EscalationPlan;
};

/** Per-process identity recorded on lease rows so operators can see who owns a PR. */
const leaseHolderId = `${os.hostname()}:${process.pid}`;

/**
 * Cooperative renewal loop. A failed renewal only warns; the fencing checks before
 * durable writes are what stop the holder at its next checkpoint.
 */
function startLeaseRenewal(
  pool: Pool,
  cfg: Config,
  key: PrActorLeaseKey,
  workItemId: string,
  leaseEpoch: number,
  onLost: () => void,
): () => void {
  const timer = setInterval(() => {
    void renewPrActorLease(pool, {
      ...key,
      workItemId,
      leaseEpoch,
      ttlSeconds: cfg.prActorLeaseTtlSeconds,
    }).then(
      (renewed) => {
        if (!renewed) {
          logWarn("pr_actor_lease_lost", {
            workItemId,
            resourceKey: key.resourceKey,
            workType: key.workType,
            leaseEpoch,
          });
          clearInterval(timer);
          onLost();
        }
      },
      (error: unknown) => {
        logWarn("pr_actor_lease_renewal_failed", {
          workItemId,
          resourceKey: key.resourceKey,
          workType: key.workType,
          leaseEpoch,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, cfg.prActorLeaseRenewalIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Observe durable cancel or hold-loss during leased execute and abort the host
 * signal. Intake already terminalized the row; this only fires the existing
 * abort wiring. Immediate first tick, then the same interval as before.
 */
function startCancelObserve(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly leaseEpoch: number;
  readonly abort: () => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const [skip, held] = await Promise.all([
        shouldSkipWork(params.pool, { id: params.workItemId }),
        isPrActorLeaseHeld(params.pool, params.workItemId, params.leaseEpoch),
      ]);
      if (stopped) return;
      if (!skip && held) return;
      stopped = true;
      if (timer) clearInterval(timer);
      params.abort();
    } catch (error) {
      logWarn("agent_work_cancel_observe_failed", {
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void tick();
  timer = setInterval(() => {
    void tick();
  }, REVIEW_CANCEL_POLL_INTERVAL_MS);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  // Native on every supported runtime (engines node >=22.22.0, image
  // node:22.22.0): no fallback branch to maintain.
  return AbortSignal.any(signals);
}

function createLeaseMutationBoundary(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly leaseEpoch: number;
  readonly signal: AbortSignal;
  readonly checkCancellation?: boolean;
}): PrSurfaceMutationBoundary {
  async function assertNotCancelled(operationKey: string): Promise<void> {
    if (
      params.checkCancellation !== false &&
      (await shouldSkipWork(params.pool, { id: params.workItemId }))
    ) {
      throw new AppError({
        code: "agent_work.execution_aborted",
        message: "Durable execution was cancelled before a PR mutation",
        context: { workItemId: params.workItemId, operationKey },
      });
    }
  }

  return {
    signal: params.signal,
    run: async <T>(mutation: PrSurfaceMutation, mutate: () => Promise<T>) => {
      await assertNotCancelled(mutation.operationKey);
      let mutationStarted = false;
      return withOperationIntent<T>({
        client: params.pool,
        workItemId: params.workItemId,
        operationKey: mutation.operationKey,
        mutationKind: mutation.mutationKind,
        leaseEpoch: params.leaseEpoch,
        signal: params.signal,
        detail: {
          ...mutation.detail,
          resourceKey: params.resourceKey,
          leaseEpoch: params.leaseEpoch,
          surfaceMutation: true,
        },
        recover: mutation.recover as WithOperationIntentParams<T>["recover"],
        allowsUndefinedResult: mutation.allowsUndefinedResult,
        // The local gate can fail before any request reaches the surface.
        isKnownNoAcceptanceError: (error) =>
          !mutationStarted || isKnownNoAcceptanceMutationError(error),
        mutate: async () => {
          await assertNotCancelled(mutation.operationKey);
          // Ownership can change during the awaited cancellation read.
          await assertPrActorLeaseHeld(params.pool, params.workItemId, params.leaseEpoch);
          mutationStarted = true;
          return mutate();
        },
      });
    },
  };
}

let botIdentityCache: Promise<BotIdentity> | undefined;

export { mintInstallationToken };

export function clearDurableAuthCachesForTest(): void {
  if (process.env.NODE_ENV === "test") {
    clearInstallationTokenCacheForTest();
    botIdentityCache = undefined;
  }
}

function getCachedBotIdentity(cfg: Config): Promise<BotIdentity> {
  botIdentityCache ??= getAppBotIdentity(cfg).catch((error: unknown) => {
    botIdentityCache = undefined;
    throw error;
  });
  return botIdentityCache;
}

/** Reasons an executor completed with reduced output; persisted and reported, never fatal. */
export type DegradationReason =
  // verification
  | "thread_resolution_degraded"
  | "compare_files_truncated"
  | "verdict_mapping_incomplete"
  | "inventory_narrowed"
  | "stale_head"
  // ask
  | "reply_recovery_degraded"
  | "reply_outcome_unknown"
  | "publish_record_failed"
  // description
  | "publish_not_completed"
  // triage
  | "push_stale"
  | "push_closed"
  | "thread_action_missing"
  | "bulk_partial"
  | "replay_commit_errors";

/**
 * Executor-visible outcome. Completion-state interpretation stays in this module:
 * `kind` is the only branch the runtime may switch on. Invalid mixes (degradation +
 * rescheduled, or reschedule without replacement coordination) are unrepresentable.
 */
export type DurableExecutionResult =
  | { readonly kind: "completed"; readonly degradation?: readonly DegradationReason[] }
  | {
      readonly kind: "rescheduled";
      readonly replacementWorkItemId: string;
      readonly afterComplete: (boss: PgBoss) => Promise<void>;
      /** Review-owned: cancel a persisted-but-not-enqueued replacement on terminal parent failure. */
      readonly onRescheduleAbort: (boss: PgBoss, error: unknown) => Promise<void>;
    };

export type DurableHeadResolution = {
  readonly headSha: string;
  readonly pullRequest?: PullRequestForFileList;
};

export type DurableJobSpec<T extends WorkType = WorkType> = {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly job: JobWithMetadata<{ workItemId: string }>;
  readonly type: T;
  /**
   * Leased work types acquire the PR actor lease before claiming, renew it while
   * running, and fence durable writes on the lease epoch. Every blocked delivery
   * arms one throttled redelivery on `queue`, so queued-behind work (e.g.
   * `/review force`, stale-head replacements) and dead-holder recovery both
   * retry acquisition until the lease frees or lapses.
   */
  readonly prActorLease?: { readonly queue: string };
  /**
   * Test seam: run the atomic acquire-and-claim body against this client
   * instead of opening a real transaction. Production callers omit it.
   */
  readonly transactForTest?: <R>(fn: (client: PoolClient) => Promise<R>) => Promise<R>;
  readonly acceptItem?: (item: Extract<AgentWorkItemCore, { type: T }>) => boolean;
  readonly resolveHeadSha: (
    prSurface: PrSurface,
    item: Extract<AgentWorkItem, { type: T }>,
  ) => Promise<DurableHeadResolution>;
  readonly execute: (
    item: Extract<AgentWorkItem, { type: T }>,
    env: DurableExecutionContext,
  ) => Promise<DurableExecutionResult>;
  readonly onTerminalFailure?: (
    item: Extract<AgentWorkItem, { type: T }>,
    prSurface: PrSurface | undefined,
    error: unknown,
    leaseEpoch?: number | null,
  ) => Promise<void>;
  readonly onCancelled?: (
    item: Extract<AgentWorkItemCore, { type: T }>,
    prSurface: PrSurface,
    reason: string,
    leaseEpoch?: number | null,
  ) => Promise<void>;
};

export async function resolveWorkItemHead(
  prSurface: PrSurface,
  item: AgentWorkItemCore,
): Promise<DurableHeadResolution> {
  return item.headSha === DEFERRED_HEAD_SHA ? prSurface.getHead() : { headSha: item.headSha };
}

function createPrSurfaceForItem(
  cfg: Config,
  item: Pick<AgentWorkItemCore, "installationId" | "owner" | "repo" | "prNumber">,
  installation?: InstallationToken,
  mutationBoundary?: PrSurfaceMutationBoundary,
): PrSurface {
  const surface = createPrSurface({
    cfg,
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    installation,
    mutationBoundary,
  });
  return surface;
}

async function isBotCommenter(cfg: Config, commenterId?: number): Promise<boolean> {
  if (commenterId == null) return false;
  const bot = await getCachedBotIdentity(cfg);
  return bot.userId === commenterId;
}

async function recordRescheduledParentCompleted(
  pool: Pool,
  itemId: string,
  type: WorkType,
  replacementWorkItemId: string,
): Promise<void> {
  await clearResumeSnapshotsBestEffort(pool, itemId);
  logInfo("agent_work_completed", {
    type,
    workItemId: itemId,
    rescheduled: true,
    replacementWorkItemId,
  });
}

async function finishRescheduledParentWorkItem(
  pool: Pool,
  itemId: string,
  type: WorkType,
  replacementWorkItemId: string,
  leaseEpoch: number,
): Promise<void> {
  if (await markWorkCompleted(pool, itemId, leaseEpoch)) {
    await recordRescheduledParentCompleted(pool, itemId, type, replacementWorkItemId);
    return;
  }
  const refreshed = await getWorkItem(pool, itemId);
  if (refreshed?.status === "completed") {
    await recordRescheduledParentCompleted(pool, itemId, type, replacementWorkItemId);
    return;
  }
  if (await forceMarkRescheduledParentCompleted(pool, itemId, leaseEpoch)) {
    await recordRescheduledParentCompleted(pool, itemId, type, replacementWorkItemId);
    return;
  }
  throw new AppError({
    code: "agent_work.rescheduled_parent_complete_failed",
    message: `Failed to complete rescheduled parent work item ${itemId}; retry will reuse idempotent enqueue`,
    context: { workItemId: itemId },
  });
}

function workItemCommenterId(item: AgentWorkItem): number | undefined {
  switch (item.type) {
    case "review":
    case "ask":
    case "description":
    case "triage":
      return item.payload.commenterId;
    case "verification":
      return undefined;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function workItemAccepted<T extends WorkType>(
  item: AgentWorkItemCore | null,
  spec: DurableJobSpec<T>,
): item is Extract<AgentWorkItemCore, { type: T }> {
  if (!item || !isWorkItemType(item, spec.type)) return false;
  return !spec.acceptItem || spec.acceptItem(item);
}

/** Durable lifecycle phase. Skip checks run only in claiming and completing. */
type WorkItemPhase = "claiming" | "executing" | "completing";

type WorkItemPhaseState = { phase: WorkItemPhase };

function enterExecutingPhase(state: WorkItemPhaseState): void {
  state.phase = "executing";
}

function isSkipCheckSuppressed(state: WorkItemPhaseState): boolean {
  return state.phase === "executing";
}

type AtomicClaimResult =
  | { readonly acquired: true; readonly leaseEpoch: number; readonly claimed: WorkClaim }
  | {
      readonly acquired: false;
      readonly heldByWorkItemId: string | null;
      readonly leaseEpoch: number;
    }
  | null;

/**
 * Acquire the PR actor lease and claim the work item in one transaction, so a
 * crash between acquire and claim can never park a held lease on a queued row.
 * Either both commit (holder owns running work under the seeded watchdog chain)
 * or neither does (crashed delivery holds nothing; the next delivery acquires
 * immediately). A claim-null (cancel/terminal race) clears the just-acquired
 * epoch inside the same transaction. Intake cancel takes the opposite lock
 * order (item rows, then lease), so retry once on Postgres deadlock (`40P01`):
 * the retry re-reads the cancelled row and takes the claim-null path.
 * Test seam surface: integration tests drive this entry directly with a real
 * transaction to prove the atomic pair rolls back or commits together.
 */
export async function acquireAndClaimWorkItem<T extends WorkType>(params: {
  readonly pool: Pool;
  readonly boss: DurableJobSpec<T>["boss"];
  readonly queue: string;
  readonly leaseKey: PrActorLeaseKey;
  readonly core: Extract<AgentWorkItemCore, { type: T }>;
  readonly ttlSeconds: number;
  readonly priority?: number;
  readonly seededLiveHop: boolean;
  /**
   * Test seam: run the acquire+claim body against this client instead of a real
   * transaction. Unit tests pass a passthrough (their pool is a `{}` stub with
   * mocked repositories); integration tests drive this entry with a real tx or
   * omit the seam for the production default. Production callers omit it.
   */
  readonly transact?: <R>(fn: (client: PoolClient) => Promise<R>) => Promise<R>;
}): Promise<AtomicClaimResult> {
  // Production default is a real transaction: acquire and claim commit or roll
  // back together.
  const transact = params.transact ?? ((fn) => inTransaction(params.pool, fn));
  const attempt = async (): Promise<AtomicClaimResult> =>
    transact(async (client) => {
      const acquisition = await acquirePrActorLease(client, {
        ...params.leaseKey,
        workItemId: params.core.id,
        holderId: leaseHolderId,
        ttlSeconds: params.ttlSeconds,
      });
      if (!acquisition.acquired) {
        // Single send per cycle: skip the re-arm when the pre-tx seed just
        // armed a live hop; otherwise arm strictly as before.
        if (!params.seededLiveHop) {
          await armLeaseWatchdogHop(params.boss, {
            queue: params.queue,
            data: { workItemId: params.core.id },
            singletonKey: params.core.id,
            priority: params.priority,
            groupId: installationGroupId(params.core.installationId),
            workItemId: params.core.id,
            onSendFailure: "throw",
          });
        }
        return acquisition;
      }
      // A throw here rolls the whole transaction back, so the just-acquired
      // epoch never commits. Release it on the client anyway: inside a real tx
      // this is a harmless no-op under rollback, and under a mocked passthrough
      // body it clears the named epoch — without touching outer runner state,
      // so a deadlock retry still owns renewal and release on success.
      let claimed: WorkClaim | null;
      try {
        // Record the acquired epoch on the item row in the same statement:
        // intake cancel reads these per-item epochs to build exact (id, epoch)
        // release pairs, so a predecessor cancel never clears a newer epoch
        // under id reuse. Pre-fix rows keep execution_epoch = 0 (unknown).
        claimed = await claimWorkForExecution(client, params.core.id, acquisition.leaseEpoch);
      } catch (error) {
        await releasePrActorLease(client, {
          ...params.leaseKey,
          leaseEpoch: acquisition.leaseEpoch,
        });
        throw error;
      }
      if (!claimed) {
        await releasePrActorLease(client, {
          ...params.leaseKey,
          leaseEpoch: acquisition.leaseEpoch,
        });
        return null;
      }
      return { ...acquisition, claimed };
    });
  try {
    return await attempt();
  } catch (error) {
    if (isPostgresDeadlockError(error)) return attempt();
    throw error;
  }
}

function isPostgresDeadlockError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "40P01"
  );
}

/**
 * Shared scaffolding for durable work items: skip/claim/mint-token/bot-skip/head-SHA/transition/retry.
 * Callers supply only the agent-specific execute() and an optional terminal-failure publish hook.
 */
export async function runDurableWorkItem<T extends WorkType>(
  spec: DurableJobSpec<T>,
): Promise<void> {
  type TypedItem = Extract<AgentWorkItem, { type: T }>;
  type TypedCore = Extract<AgentWorkItemCore, { type: T }>;

  let workItem: TypedItem | undefined;
  let leaseEpoch: number | null = null;
  let leaseKey: PrActorLeaseKey | undefined;
  const jobSignal = spec.job.signal;
  let executionSignal = jobSignal;
  let leaseAbortController: AbortController | undefined;
  const phaseState: WorkItemPhaseState = { phase: "claiming" };
  let seededInstallation: InstallationToken | undefined;
  let executionPrSurface: PrSurface | undefined;
  let boundHeadSha: string | undefined;
  let workClaim: WorkClaim | undefined;
  /** Set while a reschedule afterComplete may still need abort on terminal failure. */
  let pendingRescheduleAbort: ((boss: PgBoss, error: unknown) => Promise<void>) | undefined;

  async function prSurfaceForHooks(
    workItemCore: TypedCore,
    installation?: InstallationToken,
  ): Promise<PrSurface> {
    const token =
      installation ??
      seededInstallation ??
      (await mintInstallationToken(spec.cfg, workItemCore.installationId));
    const mutationBoundary =
      leaseEpoch == null || leaseAbortController == null
        ? undefined
        : createLeaseMutationBoundary({
            pool: spec.pool,
            workItemId: workItemCore.id,
            resourceKey: workItemCore.resourceKey,
            leaseEpoch,
            signal: executionSignal,
            // Terminal hooks must still close the cancelled verdict.
            checkCancellation: false,
          });
    return createPrSurfaceForItem(spec.cfg, workItemCore, token, mutationBoundary);
  }

  async function invokeCancelledHook(
    itemCore: TypedCore,
    reason: string,
    installation?: InstallationToken,
  ): Promise<void> {
    if (!spec.onCancelled) return;
    // A leased item must never publish a cancellation side effect before it has
    // acquired an epoch. The auxiliary acknowledgement lane owns pre-claim
    // feedback separately.
    if (spec.prActorLease && leaseEpoch == null) {
      logInfo("agent_work_cancelled_hook_skipped_without_lease", {
        type: spec.type,
        workItemId: itemCore.id,
        reason,
      });
      return;
    }
    try {
      const prSurface = await prSurfaceForHooks(itemCore, installation);
      await spec.onCancelled(itemCore, prSurface, reason, leaseEpoch);
    } catch (error) {
      logWarn("agent_work_cancelled_hook_failed", {
        type: spec.type,
        workItemId: itemCore.id,
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function markCancelledAndInvokeHook(
    itemCore: TypedCore,
    reason: string,
    /** When set, cancel only while this lease epoch still owns the row. */
    cancelLeaseEpoch?: number | null,
    installation?: InstallationToken,
  ): Promise<void> {
    if (
      cancelLeaseEpoch != null &&
      !(await isPrActorLeaseHeld(spec.pool, itemCore.id, cancelLeaseEpoch))
    ) {
      logInfo("agent_work_stale_execution_skipped", {
        type: spec.type,
        workItemId: itemCore.id,
        leaseEpoch: cancelLeaseEpoch,
        reason,
      });
      return;
    }
    await markWorkCancelled(spec.pool, itemCore.id, cancelLeaseEpoch);
    await clearResumeSnapshotsBestEffort(spec.pool, itemCore.id);
    await invokeCancelledHook(itemCore, reason, installation);
  }

  let stopLeaseRenewal: (() => void) | undefined;
  let stopCancelObserve: (() => void) | undefined;
  /** Stop renewal and clear the lease holder in place; safe to call more than once. */
  const releaseLeaseQuietly = async (): Promise<void> => {
    stopCancelObserve?.();
    stopCancelObserve = undefined;
    stopLeaseRenewal?.();
    stopLeaseRenewal = undefined;
    if (leaseKey == null || leaseEpoch == null) return;
    const key = leaseKey;
    const epoch = leaseEpoch;
    leaseKey = undefined;
    try {
      await releasePrActorLease(spec.pool, { ...key, leaseEpoch: epoch });
    } catch (error) {
      logWarn("pr_actor_lease_release_failed", {
        type: spec.type,
        workItemId: spec.job.data.workItemId,
        resourceKey: key.resourceKey,
        leaseEpoch: epoch,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const core = await getWorkItemCore(spec.pool, spec.job.data.workItemId);
  if (!workItemAccepted(core, spec)) return;

  if (await shouldSkipWork(spec.pool, core)) {
    await markCancelledAndInvokeHook(core, "skipped_before_claim");
    return;
  }
  if (jobSignal.aborted) {
    await markCancelledAndInvokeHook(core, "job_aborted_before_claim");
    return;
  }
  // Acquire atomically with the claim: a waiting item stays queued so queue-rank
  // display and stale-queued diagnostics keep their meaning, and only the lease
  // holder flips the row to running — in the same transaction, so a crash
  // between acquire and claim can never park a held lease on a queued row.
  // A pre-commit crash rolls back: the row stays queued and the lease stays
  // free, so the next delivery acquires immediately with no TTL wait.
  // A post-commit crash is running-with-held-lease under the seeded chain.
  if (spec.prActorLease) {
    leaseKey = { resourceKey: core.resourceKey, workType: spec.type };
    // Seed one throttled watchdog hop before the transaction so any crash that
    // commits a held lease always has a chain to steal it after TTL.
    // Best-effort: a pg-boss send failure never blocks a holder whose lease is
    // free (TTL backstops it).
    let seededLiveHop = false;
    try {
      const seed = await armLeaseWatchdogHop(spec.boss, {
        queue: spec.prActorLease.queue,
        data: spec.job.data,
        singletonKey: core.id,
        priority: spec.job.priority,
        groupId: installationGroupId(core.installationId),
        workItemId: core.id,
        onSendFailure: "warn-and-proceed",
      });
      seededLiveHop = seed.liveHop;
    } catch (error) {
      logWarn("agent_work_lease_watchdog_seed_failed", {
        type: spec.type,
        workItemId: core.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const atomic = await acquireAndClaimWorkItem({
      pool: spec.pool,
      boss: spec.boss,
      queue: spec.prActorLease.queue,
      leaseKey,
      core,
      ttlSeconds: spec.cfg.prActorLeaseTtlSeconds,
      priority: spec.job.priority,
      seededLiveHop,
      transact: spec.transactForTest,
    });
    if (atomic == null) return;
    if (!atomic.acquired) {
      logInfo("pr_actor_lease_unavailable", {
        type: spec.type,
        workItemId: core.id,
        resourceKey: core.resourceKey,
        heldByWorkItemId: atomic.heldByWorkItemId,
        leaseEpoch: atomic.leaseEpoch,
      });
      return;
    }
    leaseEpoch = atomic.leaseEpoch;
    workClaim = atomic.claimed;
    leaseAbortController = new AbortController();
    executionSignal = combineAbortSignals(jobSignal, leaseAbortController.signal);
    stopLeaseRenewal = startLeaseRenewal(spec.pool, spec.cfg, leaseKey, core.id, leaseEpoch, () => {
      leaseAbortController?.abort(
        new AppError({
          code: "agent_work.pr_actor_lease_lost",
          message: "PR actor lease renewal lost ownership",
          context: { workItemId: core.id, leaseEpoch },
        }),
      );
    });
  }

  try {
    // Leased items already claimed atomically above; unleased types claim here.
    const leasedClaim = spec.prActorLease ? workClaim : undefined;
    const claimed = leasedClaim ?? (await claimWorkForExecution(spec.pool, core.id));
    if (!claimed) {
      return;
    }
    workClaim = claimed;
    enterExecutingPhase(phaseState);
    if (claimed.resumed) {
      logInfo("agent_work_resumed", {
        type: spec.type,
        workItemId: core.id,
        resourceKey: core.resourceKey,
        attemptCount: claimed.attemptCount,
      });
    }

    const rawPayload = await getWorkItemPayload(spec.pool, core.id);
    if (rawPayload === undefined) {
      return;
    }
    try {
      workItem = attachWorkItemPayload(core, rawPayload);
    } catch (error) {
      try {
        await markWorkFailed(spec.pool, core.id, error, leaseEpoch);
      } catch (markError) {
        logWarn("agent_work_failed_mark_failed", {
          type: spec.type,
          workItemId: core.id,
          leaseEpoch,
          message: markError instanceof Error ? markError.message : String(markError),
        });
      }
      throw error;
    }

    const item = workItem;

    /** Unleased types have no fencing token; leased types own the row only while their epoch holds. */
    const executionStillOwns = async (): Promise<boolean> =>
      leaseEpoch == null || (await isPrActorLeaseHeld(spec.pool, item.id, leaseEpoch));

    const cancelIfSkippable = async (reason: string, notifyHook = true) => {
      if (isSkipCheckSuppressed(phaseState)) return false;
      // A newer execution owns the lease — exit without terminalising its work item.
      if (!(await executionStillOwns())) {
        logInfo("agent_work_stale_execution_skipped", {
          type: spec.type,
          workItemId: item.id,
          leaseEpoch,
          reason,
        });
        return true;
      }
      if (!(await shouldSkipWork(spec.pool, item))) return false;
      if (notifyHook) {
        await markCancelledAndInvokeHook(item, reason, leaseEpoch, seededInstallation);
      } else {
        await markWorkCancelled(spec.pool, item.id, leaseEpoch);
        await clearResumeSnapshotsBestEffort(spec.pool, item.id);
      }
      return true;
    };

    const recheckSkippableAndCancel = async (reason: string, notifyHook = true) => {
      phaseState.phase = "completing";
      return cancelIfSkippable(reason, notifyHook);
    };

    async function prepareDurableExecution(
      installationToken: InstallationToken,
      claim: WorkClaim,
    ): Promise<DurableExecutionContext | undefined> {
      if (await isBotCommenter(spec.cfg, workItemCommenterId(item))) {
        await markCancelledAndInvokeHook(item, "bot_commenter", leaseEpoch, installationToken);
        return undefined;
      }

      const mutationBoundary =
        leaseEpoch == null || leaseAbortController == null
          ? undefined
          : createLeaseMutationBoundary({
              pool: spec.pool,
              workItemId: item.id,
              resourceKey: item.resourceKey,
              leaseEpoch,
              signal: executionSignal,
            });
      const prSurface = createPrSurfaceForItem(spec.cfg, item, installationToken, mutationBoundary);
      const resolvedHead = await spec.resolveHeadSha(prSurface, item);
      const headSha = resolvedHead.headSha;
      if (await updateRunningWorkHeadSha(spec.pool, item.id, headSha, leaseEpoch)) {
        boundHeadSha = headSha;
        executionPrSurface = prSurface;
        return {
          prSurface,
          headSha,
          pullRequest: resolvedHead.pullRequest,
          leaseEpoch,
          signal: executionSignal,
          claim,
          escalation: escalationForAttempt(claim.attemptCount, spec.cfg),
        };
      }

      await recheckSkippableAndCancel("head_update_rejected");
      return undefined;
    }

    async function completeRescheduledResult(
      result: Extract<DurableExecutionResult, { kind: "rescheduled" }>,
    ): Promise<void> {
      if (leaseEpoch == null) {
        throw new AppError({
          code: "agent_work.pr_actor_lease_lost",
          message: "PR actor lease is no longer held by this execution",
          context: { workItemId: item.id },
        });
      }
      pendingRescheduleAbort = result.onRescheduleAbort;
      await result.afterComplete(spec.boss);
      // Enqueue finished (or was already done); do not cancel the replacement if parent complete fails.
      pendingRescheduleAbort = undefined;
      await finishRescheduledParentWorkItem(
        spec.pool,
        item.id,
        spec.type,
        result.replacementWorkItemId,
        leaseEpoch,
      );
    }

    async function invokeRescheduleAbort(error: unknown): Promise<void> {
      try {
        if (pendingRescheduleAbort) {
          await pendingRescheduleAbort(spec.boss, error);
          return;
        }
        // Earlier attempt may have persisted a replacement without registering an abort hook.
        if (isWorkItemType(item, "review")) {
          await cancelOrphanedStaleHeadReplacementOnTerminalFailure(
            spec.pool,
            spec.boss,
            item,
            error,
          );
        }
      } catch {
        // The abort helper already logged agent_work_replacement_cancel_failed at
        // error level before rethrowing; swallow here so terminal failure continues.
      }
    }

    async function publishOutcomeReaction(content: GithubReactionContent): Promise<void> {
      try {
        const prSurface = executionPrSurface ?? (await prSurfaceForHooks(item));
        await prSurface.setAcknowledgementReaction(reactionTargetsForWorkItem(item), content);
      } catch (error) {
        logWarn("agent_work_outcome_reaction_failed", {
          type: spec.type,
          workItemId: item.id,
          reaction: content,
          message: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
        });
      }
    }

    async function completeDurableExecution(result: DurableExecutionResult): Promise<void> {
      switch (result.kind) {
        case "rescheduled":
          // Replacement enqueue before skip: execute may already have transferred progress ownership.
          await completeRescheduledResult(result);
          return;
        case "completed": {
          if (await recheckSkippableAndCancel("skipped_after_execute", false)) return;
          const degradation = result.degradation ?? [];
          if (degradation.length) await markWorkPublishDegraded(spec.pool, item.id, leaseEpoch);
          if (!(await markWorkCompleted(spec.pool, item.id, leaseEpoch))) {
            await recheckSkippableAndCancel("completion_race", false);
            return;
          }
          await clearResumeSnapshotsBestEffort(spec.pool, item.id);
          logInfo("agent_work_completed", { type: spec.type, workItemId: item.id });
          await publishOutcomeReaction(GITHUB_REACTION_PLUS_ONE);
          return;
        }
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }

    async function markRetryingOrCancel(
      error: unknown,
      message: string,
      disposition: RetryDisposition,
      attemptCount: number,
    ): Promise<void> {
      if (await markWorkRetrying(spec.pool, item.id, error, leaseEpoch)) {
        const failure = classifyFailure(error);
        logWarn("agent_work_retrying", {
          type: spec.type,
          workItemId: item.id,
          message,
          providerErrorKind: classifyProviderError(error),
          pgBossRetryCount: spec.job.retryCount,
          pgBossRetryLimit: spec.job.retryLimit,
          dbAttemptCount: item.attemptCount,
          ...classifiedFailureLogFields(failure),
        });
        // The next delivery re-reads the row; report the plan it will carry so escalation
        // rate is observable without reading transcripts.
        const nextEscalation = escalationForAttempt(attemptCount + 1, spec.cfg);
        captureWorkRetried({
          workItemId: item.id,
          installationId: item.installationId,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha: item.headSha,
          workType: spec.type,
          attemptCount,
          nextAttempt: attemptCount + 1,
          retryDisposition: disposition,
          escalationKinds: nextEscalation?.kinds ?? [],
          failure: workFailureReasonFromClassified(failure),
        });
        throw error;
      }
      await recheckSkippableAndCancel("retry_claim_rejected");
    }

    function itemForHooks(): TypedItem {
      if (boundHeadSha == null || boundHeadSha === item.headSha) return item;
      return { ...item, headSha: boundHeadSha };
    }

    async function invokeTerminalFailureHook(error: unknown): Promise<void> {
      if (!spec.onTerminalFailure) return;
      if (spec.prActorLease && leaseEpoch == null) {
        logInfo("agent_work_terminal_failure_hook_skipped_without_lease", {
          type: spec.type,
          workItemId: item.id,
        });
        return;
      }
      try {
        const prSurface = executionPrSurface ?? (await prSurfaceForHooks(item));
        await spec.onTerminalFailure(itemForHooks(), prSurface, error, leaseEpoch);
      } catch (publishError) {
        logWarn("agent_work_terminal_failure_hook_failed", {
          type: spec.type,
          workItemId: item.id,
          message: publishError instanceof Error ? publishError.message : String(publishError),
        });
      }
    }

    async function handleDurableExecutionError(error: unknown): Promise<void> {
      if (isAppError(error) && error.code === "agent_work.pr_actor_lease_lost") {
        logInfo("agent_work_stale_execution_skipped", {
          type: spec.type,
          workItemId: item.id,
          leaseEpoch,
        });
        return;
      }
      if (isCancelAbortError(error)) {
        if (await recheckSkippableAndCancel("skipped_after_error")) return;
        logInfo("agent_work_stale_execution_skipped", {
          type: spec.type,
          workItemId: item.id,
          leaseEpoch,
        });
        return;
      }
      if (jobSignal.aborted) {
        await recheckSkippableAndCancel("job_aborted");
        return;
      }
      if (await recheckSkippableAndCancel("skipped_after_error")) return;
      const message = error instanceof Error ? error.message : String(error);
      const disposition = retryDispositionFor(error);
      const attemptCount = workClaim?.attemptCount ?? item.attemptCount;
      // pg-boss retryCount restarts on every lease hop job, so the durable attempt count
      // is the budget that actually bounds re-execution.
      const budgetRemains =
        attemptCount < maxAttempts(spec.cfg) && spec.job.retryCount < spec.job.retryLimit;
      // Deterministic failures get exactly one escalated replay: after that attempt the
      // work item is terminal even when budget remains.
      const mayRetry =
        disposition === "transient"
          ? budgetRemains
          : disposition === "deterministic" && attemptCount === 1 && budgetRemains;
      if (mayRetry) {
        await markRetryingOrCancel(error, message, disposition, attemptCount);
        return;
      }

      if (!(await markWorkFailed(spec.pool, item.id, error, leaseEpoch))) {
        await recheckSkippableAndCancel("failure_race");
        return;
      }
      await clearResumeSnapshotsBestEffort(spec.pool, item.id);
      await invokeRescheduleAbort(error);
      await invokeTerminalFailureHook(error);
      await publishOutcomeReaction(GITHUB_REACTION_MINUS_ONE);
      const failure = classifyFailure(error);
      const providerErrorKind = classifyProviderError(error);
      logError(
        "agent_work_failed",
        {
          type: spec.type,
          workItemId: item.id,
          installationId: item.installationId,
          owner: item.owner,
          repo: item.repo,
          pr_number: item.prNumber,
          message: sanitizeLogMessage(message),
          providerErrorKind,
          retryDisposition: disposition,
          pgBossRetryCount: spec.job.retryCount,
          pgBossRetryLimit: spec.job.retryLimit,
          dbAttemptCount: item.attemptCount,
          skipAnalyticsException: true,
          ...errorLogFields(error),
          ...classifiedFailureLogFields(failure),
        },
        error,
      );
      await captureDurableWorkCompletedWithCi(spec.pool, {
        item,
        workType: spec.type,
        outcome: "failed",
        durationMs: durationMsFromClaim(workClaim),
        attemptCount: workClaim?.attemptCount ?? item.attemptCount,
        failure: workFailureReasonFromClassified(failure),
      });
    }

    try {
      if (jobSignal.aborted) {
        await markCancelledAndInvokeHook(item, "job_aborted", leaseEpoch, seededInstallation);
        return;
      }
      if (!(await executionStillOwns())) {
        // A newer execution owns the lease — do not terminalise its work item.
        logInfo("agent_work_stale_execution_skipped", {
          type: spec.type,
          workItemId: item.id,
          leaseEpoch,
        });
        return;
      }
      // Checked after the lease is held: before that, a live holder and a dead one look alike.
      if (claimed.attemptCount > maxAttempts(spec.cfg)) {
        throw new AppError({
          code: "agent_work.attempts_exhausted",
          message: `Work item ${item.id} exhausted its ${maxAttempts(spec.cfg)} attempts`,
          context: {
            workItemId: item.id,
            attemptCount: claimed.attemptCount,
            maxAttempts: maxAttempts(spec.cfg),
          },
        });
      }
      seededInstallation = await mintInstallationToken(spec.cfg, item.installationId);
      const execution = await prepareDurableExecution(seededInstallation, claimed);
      if (!execution) return;

      logInfo("agent_work_started", {
        type: spec.type,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        leaseEpoch,
      });
      await reconcilePendingIntents(spec.pool, item.id, leaseEpoch);
      if (!(await executionStillOwns())) {
        logInfo("agent_work_stale_execution_skipped", {
          type: spec.type,
          workItemId: item.id,
          leaseEpoch,
        });
        return;
      }
      if (jobSignal.aborted) {
        await recheckSkippableAndCancel("job_aborted");
        return;
      }
      if (leaseAbortController != null && leaseEpoch != null) {
        stopCancelObserve = startCancelObserve({
          pool: spec.pool,
          workItemId: item.id,
          leaseEpoch,
          abort: () => leaseAbortController?.abort(),
        });
      }
      const result = await spec.execute(item, execution);
      await completeDurableExecution(result);
    } catch (error) {
      await handleDurableExecutionError(error);
    }
  } finally {
    // Terminal marks and hooks above ran under the lease; release happens after them so
    // no durable write from this epoch can be fenced out by an early clear. On retry
    // (markRetryingOrCancel rethrows) the next delivery re-acquires with a fresh epoch.
    // A failed SQL release leaves expiry as recovery.
    await releaseLeaseQuietly();
  }
}
