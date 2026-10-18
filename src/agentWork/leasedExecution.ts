import os from "node:os";
import type { Pool, PoolClient } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { type Config, REVIEW_CANCEL_POLL_INTERVAL_MS } from "../settings/index.ts";
import { AppError } from "../errors/appError.ts";
import { logInfo, logWarn } from "../evlog.ts";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.ts";
import type { PrSurfaceMutation, PrSurfaceMutationBoundary } from "../github/prSurface.ts";
import { inTransaction } from "../db/postgres.ts";
import {
  acquirePrActorLease,
  armLeaseWatchdogHop,
  assertPrActorLeaseHeld,
  isPrActorLeaseHeld,
  releasePrActorLease,
  renewPrActorLease,
  type PrActorLeaseKey,
} from "./prActorLease.ts";
import { publishOnce } from "./publishOnce.ts";
import { installationGroupId, type AgentWorkItemCore, type WorkType } from "./types.ts";
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
} from "./workItemStateRepository.ts";
import { errorMessage } from "../errors/errorMessage.ts";
import type { WorkExecutionStopReason } from "../analytics/workCompleted.ts";
import { fenceForEpoch } from "./writeFence.ts";

const leaseHolderId = `${os.hostname()}:${process.pid}`;

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

export async function acquireAndClaimWorkItem(params: {
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly queue: string;
  readonly leaseKey: PrActorLeaseKey;
  readonly core: AgentWorkItemCore;
  readonly ttlSeconds: number;
  readonly priority?: number;
  readonly seededLiveHop: boolean;
  readonly transact?: <R>(fn: (client: PoolClient) => Promise<R>) => Promise<R>;
}): Promise<AtomicClaimResult> {
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
      let claimed: WorkClaim | null;
      try {
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
    run: async (mutation: PrSurfaceMutation, mutate: () => Promise<unknown>) => {
      await assertNotCancelled(mutation.operationKey);
      let mutationStarted = false;
      return publishOnce({
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
        recover: mutation.recover,
        decodeResult: mutation.decodeResult,
        allowsUndefinedResult: mutation.allowsUndefinedResult,
        isKnownNoAcceptanceError: (error) =>
          !mutationStarted || isKnownNoAcceptanceMutationError(error),
        mutate: async () => {
          await assertNotCancelled(mutation.operationKey);
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
  readonly prActorLease?: { readonly queue: string };
  readonly runtime: LeasedExecutionRuntime;
};

export type LeasedExecution = {
  readonly leaseEpoch: number | null;
  readonly claim: WorkClaim;
  readonly signal: AbortSignal;
  readonly stopReason: WorkExecutionStopReason | undefined;
  owns(): Promise<boolean>;
  cancelWhileOwned(item: { readonly id: string }, reason: string): Promise<boolean | null>;
  requireLeaseEpoch(itemId: string): number;
  mutationBoundary(
    item: { readonly id: string; readonly resourceKey: string },
    options?: { readonly checkCancellation?: boolean },
  ): PrSurfaceMutationBoundary | undefined;
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
  release(): Promise<void>;
};

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
    if (core.status !== "queued" && core.status !== "running") {
      logInfo("agent_work_terminal_delivery_skipped", {
        type,
        workItemId: core.id,
        status: core.status,
      });
      return undefined;
    }
    const key: PrActorLeaseKey = { resourceKey: core.resourceKey, workType: type };
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
