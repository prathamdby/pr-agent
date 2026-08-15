import os from "node:os";
import type { JobWithMetadata } from "pg-boss";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { captureEvent } from "../analytics/index.js";
import { AppError, errorLogFields, isAppError } from "../errors/appError.js";
import { logError, logInfo, logWarn } from "../evlog.js";
import { getAppBotIdentity, type BotIdentity, type InstallationToken } from "../github/appAuth.js";
import {
  clearInstallationTokenCacheForTest,
  mintInstallationToken,
} from "../github/installationToken.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { classifyProviderError } from "../agent/providers/providerErrors.js";
import {
  classifyFailure,
  classifiedFailureLogFields,
  classifiedFailurePostHogProperties,
} from "../errors/classifiedFailure.js";
import type { PullRequestForFileList } from "../github/listPullRequestFiles.js";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  type GithubReactionContent,
} from "../settings/index.js";
import {
  claimWorkForExecution,
  forceMarkRescheduledParentCompleted,
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
  isPrActorLeaseHeld,
  PR_ACTOR_LEASE_DEFER_SECONDS,
  releasePrActorLease,
  renewPrActorLease,
  type PrActorLeaseKey,
} from "./prActorLease.js";
import { createPrSurface, type PrSurface } from "../github/prSurface.js";
import { reactionTargetsForWorkItem } from "./reactionTargets.js";
import {
  cancelOrphanedStaleHeadReplacementOnTerminalFailure,
  isStaleHeadReplacementExhausted,
} from "./reviewReschedule.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkType } from "./types.js";
import { installationGroupId, isWorkItemType } from "./types.js";
import { attachWorkItemPayload } from "./workItemPayloadSchema.js";
import { reconcilePendingIntents } from "./reconcilePendingIntents.js";
import { clearResumeSnapshotsBestEffort } from "../agent/runtime/sessionDurability.js";

export type DurableExecutionContext = {
  prSurface: PrSurface;
  headSha: string;
  pullRequest?: PullRequestForFileList;
  /** Fencing token of the PR actor lease owning this execution; null for unleased work types. */
  leaseEpoch: number | null;
  /** pg-boss job abort signal; aborted when the worker is stopped or the job is cancelled. */
  signal: AbortSignal;
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
): () => void {
  const timer = setInterval(() => {
    void renewPrActorLease(pool, {
      ...key,
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

/** Failures that must terminalise on first throw (no pg-boss / durable retry budget). */
function isNonRetryableDurableFailure(error: unknown): boolean {
  return isStaleHeadReplacementExhausted(error);
}

type DurableExecutionResult = {
  readonly degraded?: boolean;
  readonly rescheduled?: boolean;
  readonly replacementWorkItemId?: string;
  readonly afterComplete?: (boss: PgBoss) => Promise<void>;
  /** Review-owned: cancel a persisted-but-not-enqueued replacement on terminal parent failure. */
  readonly onRescheduleAbort?: (boss: PgBoss, error: unknown) => Promise<void>;
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
  ) => Promise<void>;
  readonly onCancelled?: (
    item: Extract<AgentWorkItemCore, { type: T }>,
    prSurface: PrSurface,
    reason: string,
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
): PrSurface {
  return createPrSurface({
    cfg,
    installationId: item.installationId,
    owner: item.owner,
    repo: item.repo,
    prNumber: item.prNumber,
    installation,
  });
}

async function isBotCommenter(cfg: Config, commenterId?: number): Promise<boolean> {
  if (commenterId == null) return false;
  const bot = await getCachedBotIdentity(cfg);
  return bot.userId === commenterId;
}

async function finishRescheduledParentWorkItem(
  pool: Pool,
  itemId: string,
  type: WorkType,
  replacementWorkItemId: string | undefined,
  leaseEpoch: number | null,
): Promise<void> {
  if (await markWorkCompleted(pool, itemId, leaseEpoch)) {
    await clearResumeSnapshotsBestEffort(pool, itemId);
    logInfo("agent_work_completed", {
      type,
      workItemId: itemId,
      rescheduled: true,
    });
    return;
  }
  const refreshed = await getWorkItem(pool, itemId);
  if (refreshed?.status === "completed") {
    await clearResumeSnapshotsBestEffort(pool, itemId);
    logInfo("agent_work_completed", {
      type,
      workItemId: itemId,
      rescheduled: true,
    });
    return;
  }
  if (replacementWorkItemId) {
    if (await forceMarkRescheduledParentCompleted(pool, itemId)) {
      await clearResumeSnapshotsBestEffort(pool, itemId);
      logInfo("agent_work_completed", {
        type,
        workItemId: itemId,
        rescheduled: true,
      });
      return;
    }
    throw new AppError({
      code: "agent_work.rescheduled_parent_complete_failed",
      message: `Failed to complete rescheduled parent work item ${itemId}; retry will reuse idempotent enqueue`,
      context: { workItemId: itemId },
    });
  }
  if (await shouldSkipWork(pool, refreshed ?? { id: itemId })) {
    await markWorkCancelled(pool, itemId, leaseEpoch);
    await clearResumeSnapshotsBestEffort(pool, itemId);
  }
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
  const phaseState: WorkItemPhaseState = { phase: "claiming" };
  let seededInstallation: InstallationToken | undefined;
  let executionPrSurface: PrSurface | undefined;
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
    return createPrSurfaceForItem(spec.cfg, workItemCore, token);
  }

  async function invokeCancelledHook(
    itemCore: TypedCore,
    reason: string,
    installation?: InstallationToken,
  ): Promise<void> {
    if (!spec.onCancelled) return;
    try {
      const prSurface = await prSurfaceForHooks(itemCore, installation);
      await spec.onCancelled(itemCore, prSurface, reason);
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
  /** Stop renewal and clear the lease holder in place; safe to call more than once. */
  const releaseLeaseQuietly = async (): Promise<void> => {
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
  // Acquire before claiming: a waiting item stays queued so queue-rank display and
  // stale-queued diagnostics keep their meaning, and only the lease holder flips
  // the row to running.
  if (spec.prActorLease) {
    leaseKey = { resourceKey: core.resourceKey, workType: spec.type };
    const acquisition = await acquirePrActorLease(spec.pool, {
      ...leaseKey,
      workItemId: core.id,
      holderId: leaseHolderId,
      ttlSeconds: spec.cfg.prActorLeaseTtlSeconds,
    });
    if (!acquisition.acquired) {
      // Every failed acquire arms one watchdog hop, self-held included: after a crash the
      // redelivery finds its own lease mid-TTL, and this chain steals it once it lapses.
      // singletonSeconds dedups pending copies per slot; singletonNextSlot lands the re-arm
      // past the firing copy's own row, which outlives completion (job_i4 covers all
      // non-cancelled states).
      await spec.boss.send(spec.prActorLease.queue, spec.job.data, {
        singletonKey: core.id,
        singletonSeconds: PR_ACTOR_LEASE_DEFER_SECONDS,
        singletonNextSlot: true,
        startAfter: PR_ACTOR_LEASE_DEFER_SECONDS,
        priority: spec.job.priority,
        group: { id: installationGroupId(core.installationId) },
      });
      logInfo("pr_actor_lease_unavailable", {
        type: spec.type,
        workItemId: core.id,
        resourceKey: core.resourceKey,
        heldByWorkItemId: acquisition.heldByWorkItemId,
        leaseEpoch: acquisition.leaseEpoch,
      });
      return;
    }
    leaseEpoch = acquisition.leaseEpoch;
    stopLeaseRenewal = startLeaseRenewal(spec.pool, spec.cfg, leaseKey, core.id, leaseEpoch);
  }

  if (!(await claimWorkForExecution(spec.pool, core.id))) {
    await releaseLeaseQuietly();
    return;
  }
  enterExecutingPhase(phaseState);

  const rawPayload = await getWorkItemPayload(spec.pool, core.id);
  if (rawPayload === undefined) {
    await releaseLeaseQuietly();
    return;
  }
  try {
    workItem = attachWorkItemPayload(core, rawPayload);
  } catch (error) {
    await markWorkFailed(spec.pool, core.id, error, leaseEpoch);
    await releaseLeaseQuietly();
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
  ): Promise<DurableExecutionContext | undefined> {
    if (await isBotCommenter(spec.cfg, workItemCommenterId(item))) {
      await markCancelledAndInvokeHook(item, "bot_commenter", leaseEpoch, installationToken);
      return undefined;
    }

    const prSurface = createPrSurfaceForItem(spec.cfg, item, installationToken);
    const resolvedHead = await spec.resolveHeadSha(prSurface, item);
    const headSha = resolvedHead.headSha;
    if (await updateRunningWorkHeadSha(spec.pool, item.id, headSha, leaseEpoch)) {
      executionPrSurface = prSurface;
      return {
        prSurface,
        headSha,
        pullRequest: resolvedHead.pullRequest,
        leaseEpoch,
        signal: jobSignal,
      };
    }

    await recheckSkippableAndCancel("head_update_rejected");
    return undefined;
  }

  async function completeRescheduledResult(result: DurableExecutionResult): Promise<void> {
    pendingRescheduleAbort = result.onRescheduleAbort;
    if (result.afterComplete) {
      await result.afterComplete(spec.boss);
    }
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
    } catch (abortError) {
      logWarn("agent_work_replacement_cancel_failed", {
        type: spec.type,
        workItemId: item.id,
        message: sanitizeLogMessage(
          abortError instanceof Error ? abortError.message : String(abortError),
        ),
      });
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
    // Replacement enqueue before skip: execute may already have transferred progress ownership.
    if (result.rescheduled) {
      await completeRescheduledResult(result);
      return;
    }
    if (await recheckSkippableAndCancel("skipped_after_execute", false)) return;
    if (result.degraded) await markWorkPublishDegraded(spec.pool, item.id);
    if (!(await markWorkCompleted(spec.pool, item.id, leaseEpoch))) {
      await recheckSkippableAndCancel("completion_race", false);
      return;
    }
    await clearResumeSnapshotsBestEffort(spec.pool, item.id);
    logInfo("agent_work_completed", { type: spec.type, workItemId: item.id });
    await publishOutcomeReaction(GITHUB_REACTION_PLUS_ONE);
  }

  async function markRetryingOrCancel(error: unknown, message: string): Promise<void> {
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
      throw error;
    }
    await recheckSkippableAndCancel("retry_claim_rejected");
  }

  async function invokeTerminalFailureHook(error: unknown): Promise<void> {
    if (!spec.onTerminalFailure) return;
    try {
      const prSurface = executionPrSurface ?? (await prSurfaceForHooks(item));
      await spec.onTerminalFailure(item, prSurface, error);
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
    if (jobSignal.aborted) {
      await recheckSkippableAndCancel("job_aborted");
      return;
    }
    if (await recheckSkippableAndCancel("skipped_after_error")) return;
    const message = error instanceof Error ? error.message : String(error);
    // Permanent product failures skip the pg-boss retry budget and fail on first throw.
    if (!isNonRetryableDurableFailure(error) && !(spec.job.retryCount >= spec.job.retryLimit)) {
      await markRetryingOrCancel(error, message);
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
        pgBossRetryCount: spec.job.retryCount,
        pgBossRetryLimit: spec.job.retryLimit,
        dbAttemptCount: item.attemptCount,
        ...errorLogFields(error),
        ...classifiedFailureLogFields(failure),
      },
      error,
    );
    captureEvent({
      distinctId: `installation:${item.installationId}`,
      event: "work item failed",
      properties: {
        type: spec.type,
        owner: item.owner,
        repo: item.repo,
        pr_number: item.prNumber,
        attempt_count: item.attemptCount,
        ...classifiedFailurePostHogProperties(failure),
        ...(failure.failureDomain === "provider" ? { provider_error_kind: providerErrorKind } : {}),
      },
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
    seededInstallation = await mintInstallationToken(spec.cfg, item.installationId);
    const execution = await prepareDurableExecution(seededInstallation);
    if (!execution) return;

    logInfo("agent_work_started", {
      type: spec.type,
      workItemId: item.id,
      resourceKey: item.resourceKey,
      leaseEpoch,
    });
    await reconcilePendingIntents(spec.pool, item.id);
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
    const result = await spec.execute(item, execution);
    await completeDurableExecution(result);
  } catch (error) {
    await handleDurableExecutionError(error);
  } finally {
    // Terminal marks and hooks above ran under the lease; release happens after them so
    // no durable write from this epoch can be fenced out by an early clear. On retry
    // (markRetryingOrCancel rethrows) the next delivery re-acquires with a fresh epoch.
    await releaseLeaseQuietly();
  }
}
