import os from "node:os";
import type { Pool, PoolClient } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { type Config, REVIEW_CANCEL_POLL_INTERVAL_MS } from "../settings/index.js";
import { AppError } from "../errors/appError.js";
import { logInfo, logWarn } from "../evlog.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import type { PrSurfaceMutation, PrSurfaceMutationBoundary } from "../github/prSurface.js";
import { inTransaction } from "../db/postgres.js";
import {
  acquirePrActorLease,
  armLeaseWatchdogHop,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  releasePrActorLease,
  renewPrActorLease,
  type PrActorLeaseKey,
} from "./prActorLease.js";
import { publishOnce, type PublishOnceParams } from "./publishOnce.js";
import { installationGroupId, type AgentWorkItemCore, type WorkType } from "./types.js";
import {
  beginWorkAttempt,
  claimWorkForExecution,
  forceMarkRescheduledParentCompleted,
  markWorkCancelled,
  markWorkCompleted,
  markWorkFailed,
  markWorkPublishDegraded,
  markWorkRetrying,
  shouldSkipWork,
  updateRunningWorkHeadSha,
  type WorkAttemptResult,
  type WorkClaim,
} from "./workItemStateRepository.js";
import { errorMessage } from "../errors/errorMessage.js";
import type { WorkExecutionStopReason } from "../analytics/workCompleted.js";
import { fenceForEpoch } from "./writeFence.js";

/** Per-process identity recorded on lease rows so operators can see who owns a PR. */
const leaseHolderId = `${os.hostname()}:${process.pid}`;

/**
 * Cooperative renewal loop. A failed renewal only warns; the fencing checks before
 * durable writes are what stop the holder at its next checkpoint.
 */
export function startLeaseRenewal(
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
      ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
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
          message: errorMessage(error),
        });
      },
    );
  }, cfg.queue.prActorLeaseRenewalIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Observe durable cancel or hold-loss during leased execute and abort the host
 * signal. Intake already terminalized the row; this only fires the existing
 * abort wiring. Immediate first tick, then the same interval as before.
 */
export function startCancelObserve(params: {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly leaseEpoch: number;
  readonly abort: (reason: "cancellation_observed" | "lease_lost") => void;
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
      params.abort(skip ? "cancellation_observed" : "lease_lost");
    } catch (error) {
      logWarn("agent_work_cancel_observe_failed", {
        workItemId: params.workItemId,
        leaseEpoch: params.leaseEpoch,
        message: errorMessage(error),
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

export function isPostgresDeadlockError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "40P01"
  );
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
 * Integration tests drive this entry with a real transaction to prove the pair.
 */
export async function acquireAndClaimWorkItem(params: {
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly queue: string;
  readonly leaseKey: PrActorLeaseKey;
  readonly core: AgentWorkItemCore;
  readonly ttlSeconds: number;
  readonly priority?: number;
  readonly seededLiveHop: boolean;
  /**
   * Transaction adapter owns atomic commit/rollback. The default uses Postgres.
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
        domain: "agent_work",
        kind: "execution_aborted",
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
      return publishOnce<T>({
        fence: fenceForEpoch(params.leaseEpoch),
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
        recover: mutation.recover as PublishOnceParams<T>["recover"],
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

export type LeasedExecutionRuntime = {
  readonly transaction: typeof inTransaction;
  readonly startLeaseRenewal: typeof startLeaseRenewal;
  readonly startCancelObserve: typeof startCancelObserve;
};

export type OpenLeasedExecutionParams = {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly job: JobWithMetadata<{ workItemId: string }>;
  readonly type: WorkType;
  readonly core: AgentWorkItemCore;
  /**
   * Leased work types acquire the PR actor lease with the claim, renew it while
   * running, and fence durable writes on the lease epoch. Every blocked delivery
   * arms one throttled redelivery on `queue`, so queued-behind work (e.g.
   * `/review force`, stale-head replacements) and dead-holder recovery both
   * retry acquisition until the lease frees or lapses.
   */
  readonly prActorLease?: { readonly queue: string };
  readonly runtime: LeasedExecutionRuntime;
};

/**
 * One claimed execution. Every durable status write goes through `mark`, which
 * stamps this execution's lease epoch (null for unleased work), so a displaced
 * holder can never terminalise its successor's row. Call `release` last: terminal
 * marks and hooks run under the lease, so no write from this epoch is fenced out
 * by an early clear.
 */
export type LeasedExecution = {
  /** Fencing token; null for unleased work types. */
  readonly leaseEpoch: number | null;
  /** Lifecycle timestamps from the claim that opened the execution. */
  readonly claim: WorkClaim;
  /** Job signal combined with lease loss and the cancellation observer. */
  readonly signal: AbortSignal;
  /** First observed stop cause; never a terminal-state assertion. */
  readonly stopReason: WorkExecutionStopReason | undefined;
  /** Unleased types have no fencing token; leased types own the row only while their epoch holds. */
  owns(): Promise<boolean>;
  /** Null means displaced; otherwise true only for an acknowledged winning cancellation write. */
  cancelWhileOwned(item: { readonly id: string }, reason: string): Promise<boolean | null>;
  /** Rescheduled parents complete under their epoch; an unleased or displaced run cannot. */
  requireLeaseEpoch(itemId: string): number;
  /** Mutation fence for PR writes; undefined without a lease. */
  mutationBoundary(
    item: { readonly id: string; readonly resourceKey: string },
    options?: { readonly checkCancellation?: boolean },
  ): PrSurfaceMutationBoundary | undefined;
  /** Abort `signal` when cancellation or hold loss becomes visible; no-op without a lease. */
  observeCancellation(): void;
  readonly mark: {
    beginAttempt(itemId: string, attemptLimit: number): Promise<WorkAttemptResult>;
    headSha(itemId: string, headSha: string): Promise<boolean>;
    degraded(itemId: string): Promise<void>;
    completed(itemId: string): Promise<boolean>;
    forceCompletedRescheduledParent(itemId: string): Promise<boolean>;
    retrying(itemId: string, error: unknown): Promise<boolean>;
    failed(itemId: string, error: unknown): Promise<boolean>;
  };
  /** Stop observers and renewal, then clear the holder; safe to call more than once. */
  release(): Promise<void>;
};

/**
 * Claim one work item under its lease, in the only order that survives a crash:
 * seed a throttled watchdog hop, acquire and claim in one transaction, start
 * renewal. A waiting item stays queued so queue-rank display and stale-queued
 * diagnostics keep their meaning, and only the lease holder flips the row to
 * running. A pre-commit crash rolls back: the row stays queued and the lease stays
 * free, so the next delivery acquires immediately with no TTL wait. A post-commit
 * crash is running-with-held-lease under the seeded chain. Resolves undefined when
 * there is nothing to execute: the lease is held elsewhere, or the claim lost a
 * cancel/terminal race.
 */
export async function openLeasedExecution(
  params: OpenLeasedExecutionParams,
): Promise<LeasedExecution | undefined> {
  const { cfg, pool, boss, job, type, core, runtime } = params;
  const jobSignal = job.signal;
  let leaseEpoch: number | null = null;
  let leaseKey: PrActorLeaseKey | undefined;
  let leaseAbortController: AbortController | undefined;
  let signal = jobSignal;
  let stopLeaseRenewal: (() => void) | undefined;
  let stopCancelObserve: (() => void) | undefined;
  let claim: WorkClaim;
  let stopReason: WorkExecutionStopReason | undefined;

  if (params.prActorLease) {
    const key: PrActorLeaseKey = { resourceKey: core.resourceKey, workType: type };
    // Seed one throttled watchdog hop before the transaction so any crash that
    // commits a held lease always has a chain to steal it after TTL.
    // Best-effort: a pg-boss send failure never blocks a holder whose lease is
    // free (TTL backstops it).
    let seededLiveHop = false;
    try {
      const seed = await armLeaseWatchdogHop(boss, {
        queue: params.prActorLease.queue,
        data: job.data,
        singletonKey: core.id,
        priority: job.priority,
        groupId: installationGroupId(core.installationId),
        workItemId: core.id,
        onSendFailure: "warn-and-proceed",
      });
      seededLiveHop = seed.liveHop;
    } catch (error) {
      logWarn("agent_work_lease_watchdog_seed_failed", {
        type,
        workItemId: core.id,
        message: errorMessage(error),
      });
    }
    const atomic = await acquireAndClaimWorkItem({
      pool,
      boss,
      queue: params.prActorLease.queue,
      leaseKey: key,
      core,
      ttlSeconds: cfg.queue.prActorLeaseTtlSeconds,
      priority: job.priority,
      seededLiveHop,
      transact: (fn) => runtime.transaction(pool, fn),
    });
    if (atomic == null) return undefined;
    if (!atomic.acquired) {
      logInfo("pr_actor_lease_unavailable", {
        type,
        workItemId: core.id,
        resourceKey: core.resourceKey,
        heldByWorkItemId: atomic.heldByWorkItemId,
        leaseEpoch: atomic.leaseEpoch,
      });
      return undefined;
    }
    const epoch = atomic.leaseEpoch;
    leaseKey = key;
    leaseEpoch = epoch;
    claim = atomic.claimed;
    const abortController = new AbortController();
    leaseAbortController = abortController;
    // Native on every supported runtime (engines node >=22.22.0, image
    // node:22.22.0): no fallback branch to maintain.
    signal = AbortSignal.any([jobSignal, abortController.signal]);
    stopLeaseRenewal = runtime.startLeaseRenewal(pool, cfg, key, core.id, epoch, () => {
      stopReason ??= "lease_lost";
      abortController.abort(
        new AppError({
          domain: "agent_work",
          kind: "pr_actor_lease_lost",
          message: "PR actor lease renewal lost ownership",
          context: { workItemId: core.id, leaseEpoch: epoch },
        }),
      );
    });
  } else {
    const claimed = await claimWorkForExecution(pool, core.id);
    if (!claimed) return undefined;
    claim = claimed;
  }

  const owns = async (): Promise<boolean> =>
    leaseEpoch == null || (await isPrActorLeaseHeld(pool, core.id, leaseEpoch));

  const requireLeaseEpoch = (itemId: string): number => {
    if (leaseEpoch == null) {
      throw new AppError({
        domain: "agent_work",
        kind: "pr_actor_lease_lost",
        message: "PR actor lease is no longer held by this execution",
        context: { workItemId: itemId },
      });
    }
    return leaseEpoch;
  };

  return {
    leaseEpoch,
    claim,
    signal,
    get stopReason() {
      return stopReason;
    },
    owns,
    requireLeaseEpoch,
    cancelWhileOwned: async (item, reason) => {
      if (leaseEpoch != null && !(await isPrActorLeaseHeld(pool, item.id, leaseEpoch))) {
        logInfo("agent_work_stale_execution_skipped", {
          type,
          workItemId: item.id,
          leaseEpoch,
          reason,
        });
        return null;
      }
      return markWorkCancelled(pool, item.id, leaseEpoch);
    },
    mutationBoundary: (item, options) =>
      leaseEpoch == null || leaseAbortController == null
        ? undefined
        : createLeaseMutationBoundary({
            pool,
            workItemId: item.id,
            resourceKey: item.resourceKey,
            leaseEpoch,
            signal,
            checkCancellation: options?.checkCancellation,
          }),
    observeCancellation: () => {
      if (leaseAbortController == null || leaseEpoch == null) return;
      const controller = leaseAbortController;
      stopCancelObserve = runtime.startCancelObserve({
        pool,
        workItemId: core.id,
        leaseEpoch,
        abort: (reason) => {
          stopReason ??= reason;
          controller.abort();
        },
      });
    },
    mark: {
      beginAttempt: async (itemId, attemptLimit) => {
        const start = () => beginWorkAttempt(pool, itemId, leaseEpoch, attemptLimit);
        try {
          return await start();
        } catch (error) {
          if (!isPostgresDeadlockError(error)) throw error;
          return start();
        }
      },
      headSha: (itemId, headSha) => updateRunningWorkHeadSha(pool, itemId, headSha, leaseEpoch),
      degraded: (itemId) => markWorkPublishDegraded(pool, itemId, leaseEpoch),
      completed: (itemId) => markWorkCompleted(pool, itemId, leaseEpoch),
      forceCompletedRescheduledParent: (itemId) =>
        forceMarkRescheduledParentCompleted(pool, itemId, requireLeaseEpoch(itemId)),
      retrying: (itemId, error) => markWorkRetrying(pool, itemId, error, leaseEpoch),
      failed: (itemId, error) => markWorkFailed(pool, itemId, error, leaseEpoch),
    },
    release: async () => {
      stopCancelObserve?.();
      stopCancelObserve = undefined;
      stopLeaseRenewal?.();
      stopLeaseRenewal = undefined;
      if (leaseKey == null || leaseEpoch == null) return;
      const key = leaseKey;
      const epoch = leaseEpoch;
      leaseKey = undefined;
      try {
        await releasePrActorLease(pool, { ...key, leaseEpoch: epoch });
      } catch (error) {
        logWarn("pr_actor_lease_release_failed", {
          type,
          workItemId: job.data.workItemId,
          resourceKey: key.resourceKey,
          leaseEpoch: epoch,
          message: errorMessage(error),
        });
      }
    },
  };
}
