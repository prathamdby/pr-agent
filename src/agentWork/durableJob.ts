import type { JobWithMetadata } from "pg-boss";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.js";
import { logError, logInfo, logWarn } from "../evlog.js";
import { mintBotIdentity, mintInstallationAuth } from "../github/appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../github/githubRequestError.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { classifyProviderError } from "../agent/providerErrors.js";
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
import type { AgentWorkItem, ReviewWorkPayload } from "./types.js";

export type InstallationToken = { token: string; expiresAtTs: number; ttlMs: number };

export type DurableExecutionContext = {
  installation: InstallationToken;
  headSha: string;
};

export type DurableExecutionResult = {
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
  readonly type: "review" | "ask";
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
  type: "review" | "ask",
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

/**
 * Shared scaffolding for durable work items: skip/claim/mint-token/bot-skip/head-SHA/transition/retry.
 * Callers supply only the agent-specific execute() and an optional terminal-failure publish hook.
 */
export async function runDurableWorkItem(spec: DurableJobSpec): Promise<void> {
  const { cfg, pool, boss, job, type, acceptItem, resolveHeadSha, execute, onTerminalFailure } =
    spec;

  const item = await getWorkItem(pool, job.data.workItemId);
  if (!item || item.type !== type) return;
  if (acceptItem && !acceptItem(item)) return;

  const cancelIfSkippable = async (): Promise<boolean> => {
    if (!(await shouldSkipWork(pool, item))) return false;
    await markWorkCancelled(pool, item.id);
    return true;
  };

  if (await cancelIfSkippable()) return;
  if (!(await claimWorkForExecution(pool, item.id))) return;

  let installation: InstallationToken | undefined;
  try {
    installation = await mintInstallationToken(cfg, item.installationId);
    if (
      await isBotCommenter(
        cfg,
        installation.token,
        (item.payload as { commenterId?: number }).commenterId,
      )
    ) {
      await markWorkCancelled(pool, item.id);
      return;
    }

    const headSha = await resolveHeadSha(installation.token, item);
    if (!(await updateRunningWorkHeadSha(pool, item.id, headSha))) {
      await cancelIfSkippable();
      return;
    }

    logInfo("agent_work_started", { type, workItemId: item.id, resourceKey: item.resourceKey });
    const result = await execute(item, { installation, headSha });
    if (await cancelIfSkippable()) return;
    if (result.rescheduled) {
      try {
        if (result.afterComplete) {
          await result.afterComplete(boss, job.id);
        }
      } catch (e) {
        if (result.replacementWorkItemId) {
          await markWorkFailed(pool, result.replacementWorkItemId, e);
        }
        throw e;
      }
      await finishRescheduledParentWorkItem(pool, item.id, type);
      return;
    }
    if (result.degraded) await markWorkPublishDegraded(pool, item.id);
    if (!(await markWorkCompleted(pool, item.id))) {
      await cancelIfSkippable();
      return;
    }
    logInfo("agent_work_completed", { type, workItemId: item.id });
  } catch (e) {
    if (await cancelIfSkippable()) return;
    const message = e instanceof Error ? e.message : String(e);
    if (!isTerminalPgBossAttempt(job)) {
      if (await markWorkRetrying(pool, item.id, e)) {
        logWarn("agent_work_retrying", {
          type,
          workItemId: item.id,
          message,
          providerErrorKind: classifyProviderError(e),
          pgBossRetryCount: job.retryCount,
          pgBossRetryLimit: job.retryLimit,
          dbAttemptCount: item.attemptCount,
        });
        throw e;
      }
      await cancelIfSkippable();
      return;
    }
    if (!(await markWorkFailed(pool, item.id, e))) {
      await cancelIfSkippable();
      return;
    }
    if (onTerminalFailure) {
      try {
        await onTerminalFailure(item, installation, e);
      } catch (publishError) {
        logWarn("agent_work_terminal_failure_hook_failed", {
          type,
          workItemId: item.id,
          message: publishError instanceof Error ? publishError.message : String(publishError),
        });
      }
    }
    logError("agent_work_failed", {
      type,
      workItemId: item.id,
      message: sanitizeLogMessage(message),
      providerErrorKind: classifyProviderError(e),
      pgBossRetryCount: job.retryCount,
      pgBossRetryLimit: job.retryLimit,
      dbAttemptCount: item.attemptCount,
    });
  }
}
