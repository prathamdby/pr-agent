import type { JobWithMetadata } from "pg-boss";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { logError, logInfo, logWarn } from "../evlog.js";
import {
  mintBotIdentity,
  mintInstallationAuth,
  type InstallationToken,
} from "../github/appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../github/githubRequestError.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { classifyProviderError } from "../agent/providerErrors.js";
import { DEFERRED_HEAD_SHA } from "../settings/index.js";
import {
  claimWorkForExecution,
  forceMarkRescheduledParentCompleted,
  getWorkItem,
  markWorkCancelled,
  markWorkCompleted,
  markWorkFailed,
  markWorkPublishDegraded,
  markWorkRetrying,
  shouldSkipWork,
  updateRunningWorkHeadSha,
} from "./repository.js";
import { getPullRequestHeadSha } from "./githubPrSurface.js";
import type { AgentWorkItem, ReviewWorkPayload } from "./types.js";

type DurableExecutionContext = {
  installation: InstallationToken;
  headSha: string;
};

type DurableExecutionResult = {
  readonly degraded?: boolean;
  readonly rescheduled?: boolean;
  readonly replacementWorkItemId?: string;
  readonly afterComplete?: (boss: PgBoss, activePgBossJobId: string) => Promise<void>;
};

export type DurableJobSpec = {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly boss: PgBoss;
  readonly job: JobWithMetadata<{ workItemId: string }>;
  readonly type: "review" | "ask" | "description";
  readonly acceptItem?: (item: AgentWorkItem) => boolean;
  readonly resolveHeadSha: (token: string, item: AgentWorkItem) => Promise<string>;
  readonly execute: (
    item: AgentWorkItem,
    env: DurableExecutionContext,
  ) => Promise<DurableExecutionResult>;
  readonly onTerminalFailure?: (
    item: AgentWorkItem,
    installation: InstallationToken | undefined,
    error: unknown,
  ) => Promise<void>;
};

export async function mintInstallationToken(
  cfg: Config,
  installationId: number,
): Promise<InstallationToken> {
  const auth = await mintInstallationAuth(cfg, installationId);
  const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
  const now = Date.now();
  const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
  return { token: auth.token, expiresAtTs, ttlMs: Math.max(0, expiresAtTs - now) };
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

export async function resolveWorkItemHeadSha(token: string, item: AgentWorkItem): Promise<string> {
  return item.headSha === DEFERRED_HEAD_SHA
    ? getPullRequestHeadSha(token, item.owner, item.repo, item.prNumber)
    : item.headSha;
}

async function isBotCommenter(cfg: Config, token: string, commenterId?: number): Promise<boolean> {
  if (commenterId == null) return false;
  const bot = await mintBotIdentity(cfg, token);
  return bot.userId === commenterId;
}

function isTerminalPgBossAttempt(job: JobWithMetadata<unknown>): boolean {
  return job.retryCount >= job.retryLimit;
}

async function finishRescheduledParentWorkItem(
  pool: Pool,
  itemId: string,
  type: DurableJobSpec["type"],
): Promise<void> {
  if (await markWorkCompleted(pool, itemId)) {
    logInfo("agent_work_completed", { type, workItemId: itemId, rescheduled: true });
    return;
  }
  const refreshed = await getWorkItem(pool, itemId);
  if (refreshed?.status === "completed") {
    logInfo("agent_work_completed", { type, workItemId: itemId, rescheduled: true });
    return;
  }
  const payload = refreshed?.payload as ReviewWorkPayload | undefined;
  if (payload?.staleHeadReplacementWorkItemId) {
    if (await forceMarkRescheduledParentCompleted(pool, itemId)) {
      logInfo("agent_work_completed", { type, workItemId: itemId, rescheduled: true });
      return;
    }
    throw new Error(
      `Failed to complete rescheduled parent work item ${itemId}; retry will reuse idempotent enqueue`,
    );
  }
  if (await shouldSkipWork(pool, refreshed ?? ({ id: itemId } as AgentWorkItem))) {
    await markWorkCancelled(pool, itemId);
  }
}

type CancelIfSkippable = () => Promise<boolean>;

function workItemAccepted(item: AgentWorkItem | null, spec: DurableJobSpec): item is AgentWorkItem {
  if (!item || item.type !== spec.type) return false;
  return !spec.acceptItem || spec.acceptItem(item);
}

function makeCancelIfSkippable(pool: Pool, item: AgentWorkItem): CancelIfSkippable {
  return async () => {
    if (!(await shouldSkipWork(pool, item))) return false;
    await markWorkCancelled(pool, item.id);
    return true;
  };
}

async function prepareDurableExecution(
  spec: DurableJobSpec,
  item: AgentWorkItem,
  cancelIfSkippable: CancelIfSkippable,
): Promise<DurableExecutionContext | undefined> {
  const installation = await mintInstallationToken(spec.cfg, item.installationId);
  const commenterId = (item.payload as { commenterId?: number }).commenterId;
  if (await isBotCommenter(spec.cfg, installation.token, commenterId)) {
    await markWorkCancelled(spec.pool, item.id);
    return undefined;
  }

  const headSha = await spec.resolveHeadSha(installation.token, item);
  if (await updateRunningWorkHeadSha(spec.pool, item.id, headSha)) {
    return { installation, headSha };
  }

  await cancelIfSkippable();
  return undefined;
}

async function completeRescheduledResult(
  spec: DurableJobSpec,
  item: AgentWorkItem,
  result: DurableExecutionResult,
): Promise<void> {
  try {
    if (result.afterComplete) {
      await result.afterComplete(spec.boss, spec.job.id);
    }
  } catch (e) {
    if (result.replacementWorkItemId) {
      await markWorkFailed(spec.pool, result.replacementWorkItemId, e);
    }
    throw e;
  }
  await finishRescheduledParentWorkItem(spec.pool, item.id, spec.type);
}

async function completeDurableExecution(
  spec: DurableJobSpec,
  item: AgentWorkItem,
  result: DurableExecutionResult,
  cancelIfSkippable: CancelIfSkippable,
): Promise<void> {
  if (await cancelIfSkippable()) return;
  if (result.rescheduled) {
    await completeRescheduledResult(spec, item, result);
    return;
  }
  if (result.degraded) await markWorkPublishDegraded(spec.pool, item.id);
  if (!(await markWorkCompleted(spec.pool, item.id))) {
    await cancelIfSkippable();
    return;
  }
  logInfo("agent_work_completed", { type: spec.type, workItemId: item.id });
}

async function markRetryingOrCancel(
  spec: DurableJobSpec,
  item: AgentWorkItem,
  error: unknown,
  message: string,
  cancelIfSkippable: CancelIfSkippable,
): Promise<void> {
  if (await markWorkRetrying(spec.pool, item.id, error)) {
    logWarn("agent_work_retrying", {
      type: spec.type,
      workItemId: item.id,
      message,
      providerErrorKind: classifyProviderError(error),
      pgBossRetryCount: spec.job.retryCount,
      pgBossRetryLimit: spec.job.retryLimit,
      dbAttemptCount: item.attemptCount,
    });
    throw error;
  }
  await cancelIfSkippable();
}

async function invokeTerminalFailureHook(
  spec: DurableJobSpec,
  item: AgentWorkItem,
  installation: InstallationToken | undefined,
  error: unknown,
): Promise<void> {
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

async function handleDurableExecutionError(
  spec: DurableJobSpec,
  item: AgentWorkItem,
  installation: InstallationToken | undefined,
  error: unknown,
  cancelIfSkippable: CancelIfSkippable,
): Promise<void> {
  if (await cancelIfSkippable()) return;
  const message = error instanceof Error ? error.message : String(error);
  if (!isTerminalPgBossAttempt(spec.job)) {
    await markRetryingOrCancel(spec, item, error, message, cancelIfSkippable);
    return;
  }

  if (!(await markWorkFailed(spec.pool, item.id, error))) {
    await cancelIfSkippable();
    return;
  }
  await invokeTerminalFailureHook(spec, item, installation, error);
  logError("agent_work_failed", {
    type: spec.type,
    workItemId: item.id,
    message: sanitizeLogMessage(message),
    providerErrorKind: classifyProviderError(error),
    pgBossRetryCount: spec.job.retryCount,
    pgBossRetryLimit: spec.job.retryLimit,
    dbAttemptCount: item.attemptCount,
  });
}

/**
 * Shared scaffolding for durable work items: skip/claim/mint-token/bot-skip/head-SHA/transition/retry.
 * Callers supply only the agent-specific execute() and an optional terminal-failure publish hook.
 */
export async function runDurableWorkItem(spec: DurableJobSpec): Promise<void> {
  const item = await getWorkItem(spec.pool, spec.job.data.workItemId);
  if (!workItemAccepted(item, spec)) return;

  const cancelIfSkippable = makeCancelIfSkippable(spec.pool, item);
  if (await cancelIfSkippable()) return;
  if (!(await claimWorkForExecution(spec.pool, item.id))) return;

  let installation: InstallationToken | undefined;
  try {
    const execution = await prepareDurableExecution(spec, item, cancelIfSkippable);
    if (!execution) return;
    installation = execution.installation;

    logInfo("agent_work_started", {
      type: spec.type,
      workItemId: item.id,
      resourceKey: item.resourceKey,
    });
    const result = await spec.execute(item, execution);
    await completeDurableExecution(spec, item, result, cancelIfSkippable);
  } catch (error) {
    await handleDurableExecutionError(spec, item, installation, error, cancelIfSkippable);
  }
}
