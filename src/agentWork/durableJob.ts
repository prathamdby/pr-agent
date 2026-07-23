import type { JobWithMetadata } from "pg-boss";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { captureEvent } from "../analytics/index.js";
import { AppError, errorLogFields } from "../errors/appError.js";
import { logError, logInfo, logWarn } from "../evlog.js";
import {
  getAppBotIdentity,
  mintInstallationAuth,
  type BotIdentity,
  type InstallationToken,
} from "../github/appAuth.js";
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
  INSTALLATION_TOKEN_FALLBACK_TTL_MS,
  TOKEN_FRESHNESS_BUFFER_MS,
  type GithubReactionContent,
} from "../settings/index.js";
import {
  claimQueuedWorkItem,
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
import { getPullRequestHead, reactOnAckTargets } from "./githubPrSurface.js";
import { reactionTargetsForWorkItem } from "./reactionTargets.js";
import { cancelOrphanedStaleHeadReplacementOnTerminalFailure } from "./reviewReschedule.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkType } from "./types.js";
import { isWorkItemType } from "./types.js";
import { attachWorkItemPayload } from "./workItemPayloadSchema.js";
import { reconcilePendingIntents } from "./reconcilePendingIntents.js";
import { clearResumeSnapshotsBestEffort } from "../agent/runtime/sessionDurability.js";

type DurableExecutionContext = {
  installation: InstallationToken;
  headSha: string;
  pullRequest?: PullRequestForFileList;
};

const installationTokenCache = new Map<number, InstallationToken | Promise<InstallationToken>>();
let botIdentityCache: Promise<BotIdentity> | undefined;

export function clearDurableAuthCachesForTest(): void {
  if (process.env.NODE_ENV === "test") {
    installationTokenCache.clear();
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

type DurableExecutionResult = {
  readonly degraded?: boolean;
  readonly rescheduled?: boolean;
  readonly replacementWorkItemId?: string;
  readonly afterComplete?: (boss: PgBoss, activePgBossJobId: string) => Promise<void>;
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
  readonly acceptItem?: (item: Extract<AgentWorkItemCore, { type: T }>) => boolean;
  readonly resolveHeadSha: (
    token: string,
    expiresAtTs: number,
    item: Extract<AgentWorkItem, { type: T }>,
  ) => Promise<DurableHeadResolution>;
  readonly execute: (
    item: Extract<AgentWorkItem, { type: T }>,
    env: DurableExecutionContext,
  ) => Promise<DurableExecutionResult>;
  readonly onTerminalFailure?: (
    item: Extract<AgentWorkItem, { type: T }>,
    installation: InstallationToken | undefined,
    error: unknown,
  ) => Promise<void>;
  readonly onCancelled?: (
    item: Extract<AgentWorkItemCore, { type: T }>,
    installation: InstallationToken,
    reason: string,
  ) => Promise<void>;
};

export async function mintInstallationToken(
  cfg: Config,
  installationId: number,
): Promise<InstallationToken> {
  const cached = installationTokenCache.get(installationId);
  if (cached) {
    const token = await cached;
    if (token.expiresAtTs - Date.now() > TOKEN_FRESHNESS_BUFFER_MS) return token;
  }

  const pending = (async () => {
    const auth = await mintInstallationAuth(cfg, installationId);
    const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
    const now = Date.now();
    const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
    return {
      token: auth.token,
      expiresAtTs,
      ttlMs: Math.max(0, expiresAtTs - now),
    };
  })();
  installationTokenCache.set(installationId, pending);
  try {
    const token = await pending;
    installationTokenCache.set(installationId, token);
    return token;
  } catch (error) {
    installationTokenCache.delete(installationId);
    throw error;
  }
}

export function makeInstallationTokenRefresher(
  cfg: Config,
  installationId: number,
  holder: { installation: InstallationToken },
): () => Promise<{ token: string; expiresAtTs: number }> {
  return async () => {
    const fresh = await mintInstallationToken(cfg, installationId);
    holder.installation = fresh;
    return { token: fresh.token, expiresAtTs: fresh.expiresAtTs };
  };
}

export async function resolveWorkItemHead(
  token: string,
  expiresAtTs: number,
  item: AgentWorkItemCore,
): Promise<DurableHeadResolution> {
  return item.headSha === DEFERRED_HEAD_SHA
    ? getPullRequestHead(token, item.owner, item.repo, item.prNumber, expiresAtTs)
    : { headSha: item.headSha };
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
): Promise<void> {
  if (await markWorkCompleted(pool, itemId)) {
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
    await markWorkCancelled(pool, itemId);
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
  const phaseState: WorkItemPhaseState = { phase: "claiming" };
  let installation: InstallationToken | undefined;
  /** Set while a reschedule afterComplete may still need abort on terminal failure. */
  let pendingRescheduleAbort: ((boss: PgBoss, error: unknown) => Promise<void>) | undefined;

  async function invokeCancelledHook(
    item: TypedCore,
    currentInstallation: InstallationToken | undefined,
    reason: string,
  ): Promise<void> {
    if (!spec.onCancelled) return;
    try {
      const token =
        currentInstallation ?? (await mintInstallationToken(spec.cfg, item.installationId));
      await spec.onCancelled(item, token, reason);
    } catch (error) {
      logWarn("agent_work_cancelled_hook_failed", {
        type: spec.type,
        workItemId: item.id,
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function markCancelledAndInvokeHook(
    item: TypedCore,
    currentInstallation: InstallationToken | undefined,
    reason: string,
  ): Promise<void> {
    await markWorkCancelled(spec.pool, item.id);
    await clearResumeSnapshotsBestEffort(spec.pool, item.id);
    await invokeCancelledHook(item, currentInstallation, reason);
  }

  if (spec.acceptItem == null) {
    workItem =
      (await claimQueuedWorkItem(spec.pool, spec.job.data.workItemId, spec.type)) ?? undefined;
    if (workItem) enterExecutingPhase(phaseState);
  }

  if (workItem === undefined) {
    const core = await getWorkItemCore(spec.pool, spec.job.data.workItemId);
    if (!workItemAccepted(core, spec)) return;

    const cancelBeforeClaim = async () => {
      if (isSkipCheckSuppressed(phaseState)) return false;
      if (!(await shouldSkipWork(spec.pool, core))) return false;
      await markCancelledAndInvokeHook(core, installation, "skipped_before_claim");
      return true;
    };

    if (await cancelBeforeClaim()) return;
    if (!(await claimWorkForExecution(spec.pool, core.id))) return;
    enterExecutingPhase(phaseState);
    const rawPayload = await getWorkItemPayload(spec.pool, core.id);
    if (rawPayload === undefined) return;
    try {
      workItem = attachWorkItemPayload(core, rawPayload);
    } catch (error) {
      await markWorkFailed(spec.pool, core.id, error);
      throw error;
    }
  }

  const item = workItem;

  const cancelIfSkippable = async (reason: string, notifyHook = true) => {
    if (isSkipCheckSuppressed(phaseState)) return false;
    if (!(await shouldSkipWork(spec.pool, item))) return false;
    if (notifyHook) {
      await markCancelledAndInvokeHook(item, installation, reason);
    } else {
      await markWorkCancelled(spec.pool, item.id);
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
      await markCancelledAndInvokeHook(item, installationToken, "bot_commenter");
      return undefined;
    }

    const resolvedHead = await spec.resolveHeadSha(
      installationToken.token,
      installationToken.expiresAtTs,
      item,
    );
    const headSha = resolvedHead.headSha;
    if (await updateRunningWorkHeadSha(spec.pool, item.id, headSha)) {
      return {
        installation: installationToken,
        headSha,
        pullRequest: resolvedHead.pullRequest,
      };
    }

    await recheckSkippableAndCancel("head_update_rejected");
    return undefined;
  }

  async function completeRescheduledResult(result: DurableExecutionResult): Promise<void> {
    pendingRescheduleAbort = result.onRescheduleAbort;
    if (result.afterComplete) {
      await result.afterComplete(spec.boss, spec.job.id);
    }
    // Enqueue finished (or was already done); do not cancel the replacement if parent complete fails.
    pendingRescheduleAbort = undefined;
    await finishRescheduledParentWorkItem(
      spec.pool,
      item.id,
      spec.type,
      result.replacementWorkItemId,
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
      const token = installation ?? (await mintInstallationToken(spec.cfg, item.installationId));
      let botUserId: number | undefined;
      try {
        botUserId = (await getCachedBotIdentity(spec.cfg)).userId;
      } catch (identityError) {
        logWarn("agent_work_outcome_reaction_bot_identity_failed", {
          type: spec.type,
          workItemId: item.id,
          reaction: content,
          message: sanitizeLogMessage(
            identityError instanceof Error ? identityError.message : String(identityError),
          ),
        });
      }
      await reactOnAckTargets(
        token.token,
        item.owner,
        item.repo,
        reactionTargetsForWorkItem(item),
        content,
        botUserId,
        token.expiresAtTs,
      );
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
    if (await recheckSkippableAndCancel("skipped_after_execute", false)) return;
    if (result.rescheduled) {
      await completeRescheduledResult(result);
      return;
    }
    if (result.degraded) await markWorkPublishDegraded(spec.pool, item.id);
    if (!(await markWorkCompleted(spec.pool, item.id))) {
      await recheckSkippableAndCancel("completion_race", false);
      return;
    }
    await clearResumeSnapshotsBestEffort(spec.pool, item.id);
    logInfo("agent_work_completed", { type: spec.type, workItemId: item.id });
    await publishOutcomeReaction(GITHUB_REACTION_PLUS_ONE);
  }

  async function markRetryingOrCancel(error: unknown, message: string): Promise<void> {
    if (await markWorkRetrying(spec.pool, item.id, error)) {
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
      await spec.onTerminalFailure(item, installation, error);
    } catch (publishError) {
      logWarn("agent_work_terminal_failure_hook_failed", {
        type: spec.type,
        workItemId: item.id,
        message: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
  }

  async function handleDurableExecutionError(error: unknown): Promise<void> {
    if (await recheckSkippableAndCancel("skipped_after_error")) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!(spec.job.retryCount >= spec.job.retryLimit)) {
      await markRetryingOrCancel(error, message);
      return;
    }

    if (!(await markWorkFailed(spec.pool, item.id, error))) {
      await recheckSkippableAndCancel("failure_race");
      return;
    }
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
    installation = await mintInstallationToken(spec.cfg, item.installationId);
    const execution = await prepareDurableExecution(installation);
    if (!execution) return;

    logInfo("agent_work_started", {
      type: spec.type,
      workItemId: item.id,
      resourceKey: item.resourceKey,
    });
    await reconcilePendingIntents(spec.pool, item.id);
    const result = await spec.execute(item, execution);
    await completeDurableExecution(result);
  } catch (error) {
    await handleDurableExecutionError(error);
  }
}
