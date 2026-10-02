import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import {
  captureWorkRetried,
  recordWorkCompleted,
  type WorkCompletion,
  durationMsFromClaim,
  workFailureReasonFromClassified,
} from "../analytics/workCompleted.js";
import { loadCiWorkTelemetry } from "./ciWorkTelemetry.js";
import { AppError, errorLogFields, isAppError } from "../errors/appError.js";
import { logError, logInfo, logWarn } from "../evlog.js";
import type { InstallationToken } from "../github/appAuth.js";
import { productionInstallationSurface, type InstallationSurface } from "./installationSurface.js";
import { sanitizeLogMessage } from "../security/sanitizeLogMessage.js";
import { classifyProviderError, isCancelAbortError } from "../agent/providers/providerErrors.js";
import { classifyFailure, classifiedFailureLogFields } from "../errors/classifiedFailure.js";
import type { PullRequestForFileList } from "../github/listPullRequestFiles.js";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  type GithubReactionContent,
} from "../settings/index.js";
import {
  getWorkItem,
  getWorkItemCore,
  getWorkItemPayload,
  markWorkCancelled,
  shouldSkipWork,
  type WorkClaim,
} from "./workItemStateRepository.js";
import { isPrActorLeaseHeld } from "./prActorLease.js";
import {
  openLeasedExecution,
  startCancelObserve,
  startLeaseRenewal,
  type LeasedExecution,
  type LeasedExecutionRuntime,
} from "./leasedExecution.js";
import { type PrSurface } from "../github/prSurface.js";
import { reactionTargetsForWorkItem } from "./reactionTargets.js";
import {
  escalationForAttempt,
  maxAttempts,
  retryDispositionFor,
  type EscalationPlan,
  type RetryDisposition,
} from "./retryPolicy.js";
import type { AgentWorkItem, AgentWorkItemCore, WorkType } from "./types.js";
import { inTransaction } from "../db/postgres.js";
import { isWorkItemType } from "./types.js";
import { attachWorkItemPayload } from "./workItemPayloadSchema.js";
import { reconcilePendingIntents } from "./reconcilePendingIntents.js";
import {
  withPrRepositoryView,
  type PreparePrRepositoryViewParams,
  type PrRepositoryView,
} from "../prWorkspace/prRepositoryView.js";

export type DurableExecutionContext = {
  readonly job: JobWithMetadata<{ workItemId: string }>;
  prSurface: PrSurface;
  headSha: string;
  pullRequest?: PullRequestForFileList;
  /** Fencing token of the PR actor lease owning this execution; null for unleased work types. */
  leaseEpoch: number | null;
  /** Combined job/lease signal; aborted when the worker is stopped, cancelled, or fenced. */
  signal: AbortSignal;
  /** Admit fresh feature work once per dispatch, before preparing its workspace. */
  beginAttempt: () => Promise<WorkClaim>;
  /** Admission precedes every read-only checkout; recovery callers need not acquire one. */
  withAdmittedRepositoryView: <T>(
    options: Pick<PreparePrRepositoryViewParams, "repositorySizeKb" | "prFiles">,
    run: (view: PrRepositoryView) => Promise<T>,
  ) => Promise<T>;
  /** Session identity only, independent of snapshot/checkpoint storage. */
  readonly durability: {
    readonly pool: Pool;
    readonly workItemId: string;
    readonly installationId: number;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  };
  /** Shared signal/cancellation/lease policy; feature-specific head checks stay with the feature. */
  shouldAbortPublish: () => Promise<boolean>;
  /** Lifecycle timestamps and the latest acknowledged durable work count. */
  readonly claim?: WorkClaim;
  /** Deterministic escalation for this attempt; undefined on attempt 1. */
  readonly escalation?: EscalationPlan;
};

export function createDurableExecutionContext(
  params: Omit<
    DurableExecutionContext,
    "claim" | "escalation" | "withAdmittedRepositoryView" | "durability" | "shouldAbortPublish"
  > & {
    readonly pool: Pool;
    readonly item: AgentWorkItem;
    readonly getClaim: () => WorkClaim | undefined;
    readonly getEscalation: () => EscalationPlan | undefined;
  },
): DurableExecutionContext {
  const { pool, item, getClaim, getEscalation, beginAttempt, ...context } = params;
  let admission: Promise<WorkClaim> | undefined;
  const admit = () => (admission ??= beginAttempt());
  return {
    ...context,
    beginAttempt: admit,
    withAdmittedRepositoryView: async (options, run) => {
      await admit();
      return withPrRepositoryView(
        {
          ...options,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha: context.headSha,
          pullRequest: context.pullRequest,
          gitCredentialAuth: () => context.prSurface.gitCredentialAuth(),
        },
        run,
      );
    },
    durability: {
      pool,
      workItemId: item.id,
      installationId: item.installationId,
      owner: item.owner,
      repo: item.repo,
      prNumber: item.prNumber,
    },
    shouldAbortPublish: async () =>
      context.signal.aborted ||
      (await shouldSkipWork(pool, item)) ||
      (context.leaseEpoch != null &&
        !(await isPrActorLeaseHeld(pool, item.id, context.leaseEpoch))),
    get claim() {
      return getClaim();
    },
    get escalation() {
      return getEscalation();
    },
  };
}

export type DurableRuntime = LeasedExecutionRuntime & {
  readonly installationSurface: InstallationSurface;
};

export function createDurableRuntime(dependencies: Partial<DurableRuntime> = {}): DurableRuntime {
  return {
    installationSurface: productionInstallationSurface,
    transaction: inTransaction,
    startLeaseRenewal,
    startCancelObserve,
    ...dependencies,
  };
}

/**
 * Executor-visible outcome. Completion-state interpretation stays in this module:
 * `kind` is the only branch the runtime may switch on. Invalid mixes (degradation +
 * rescheduled, or reschedule without replacement coordination) are unrepresentable.
 */
export type DurableExecutionResult =
  | {
      readonly kind: "completed";
      /** Feature-owned reasons, persisted and reported, never fatal. */
      readonly degradation?: readonly string[];
      readonly completion?: WorkCompletion;
    }
  | {
      readonly kind: "rescheduled";
      readonly replacementWorkItemId: string;
      readonly afterComplete: (boss: PgBoss) => Promise<void>;
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
  /** See `OpenLeasedExecutionParams.prActorLease`. */
  readonly prActorLease?: { readonly queue: string };
  readonly runtime?: DurableRuntime;
  readonly acceptItem?: (item: Extract<AgentWorkItemCore, { type: T }>) => boolean;
  readonly contextPolicy: {
    readonly commenterId: (item: Extract<AgentWorkItem, { type: T }>) => number | undefined;
  };
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

async function isBotCommenter(
  installationSurface: InstallationSurface,
  cfg: Config,
  commenterId?: number,
): Promise<boolean> {
  if (commenterId == null) return false;
  const bot = await installationSurface.botIdentity(cfg);
  return bot.userId === commenterId;
}

async function recordRescheduledParentCompleted(
  itemId: string,
  type: WorkType,
  replacementWorkItemId: string,
): Promise<void> {
  logInfo("agent_work_completed", {
    type,
    workItemId: itemId,
    rescheduled: true,
    replacementWorkItemId,
  });
}

async function finishRescheduledParentWorkItem(
  lease: LeasedExecution,
  itemId: string,
  type: WorkType,
  replacementWorkItemId: string,
  pool: Pool,
): Promise<void> {
  if (await lease.mark.completed(itemId)) {
    await recordRescheduledParentCompleted(itemId, type, replacementWorkItemId);
    return;
  }
  const refreshed = await getWorkItem(pool, itemId);
  if (refreshed?.status === "completed") {
    await recordRescheduledParentCompleted(itemId, type, replacementWorkItemId);
    return;
  }
  if (await lease.mark.forceCompletedRescheduledParent(itemId)) {
    await recordRescheduledParentCompleted(itemId, type, replacementWorkItemId);
    return;
  }
  throw new AppError({
    code: "agent_work.rescheduled_parent_complete_failed",
    message: `Failed to complete rescheduled parent work item ${itemId}; retry will reuse idempotent enqueue`,
    context: { workItemId: itemId },
  });
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
 * Lease ordering and epoch-fenced status writes live in `leasedExecution.ts`.
 */
export async function runDurableWorkItem<T extends WorkType>(
  spec: DurableJobSpec<T>,
): Promise<void> {
  type TypedItem = Extract<AgentWorkItem, { type: T }>;
  type TypedCore = Extract<AgentWorkItemCore, { type: T }>;

  let workItem: TypedItem | undefined;
  let lease: LeasedExecution | undefined;
  const runtime = spec.runtime ?? createDurableRuntime();
  const jobSignal = spec.job.signal;
  const phaseState: WorkItemPhaseState = { phase: "claiming" };
  let seededInstallation: InstallationToken | undefined;
  let executionPrSurface: PrSurface | undefined;
  let boundHeadSha: string | undefined;
  let workClaim: WorkClaim | undefined;

  async function prSurfaceForHooks(
    workItemCore: TypedCore,
    installation?: InstallationToken,
  ): Promise<PrSurface> {
    const token =
      installation ??
      seededInstallation ??
      (await runtime.installationSurface.token(spec.cfg, workItemCore.installationId));
    return runtime.installationSurface.create({
      cfg: spec.cfg,
      installationId: workItemCore.installationId,
      owner: workItemCore.owner,
      repo: workItemCore.repo,
      prNumber: workItemCore.prNumber,
      installation: token,
      // Terminal hooks must still close the cancelled verdict.
      mutationBoundary: lease?.mutationBoundary(workItemCore, { checkCancellation: false }),
    });
  }

  async function invokeCancelledHook(
    itemCore: TypedCore,
    reason: string,
    installation?: InstallationToken,
  ): Promise<void> {
    if (!spec.onCancelled) return;
    const leaseEpoch = lease?.leaseEpoch ?? null;
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
    installation?: InstallationToken,
  ): Promise<void> {
    if (lease) {
      if (!(await lease.cancel(itemCore, reason))) return;
    } else {
      await markWorkCancelled(spec.pool, itemCore.id, null);
    }
    await invokeCancelledHook(itemCore, reason, installation);
  }

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

  lease = await openLeasedExecution({
    cfg: spec.cfg,
    pool: spec.pool,
    boss: spec.boss,
    job: spec.job,
    type: spec.type,
    core,
    prActorLease: spec.prActorLease,
    runtime,
  });
  if (!lease) return;
  const opened = lease;
  const leaseEpoch = opened.leaseEpoch;
  const executionSignal = opened.signal;

  try {
    workClaim = opened.claim;
    const resumed = workClaim.resumed;
    enterExecutingPhase(phaseState);
    if (workClaim.resumed) {
      logInfo("agent_work_resumed", {
        type: spec.type,
        workItemId: core.id,
        resourceKey: core.resourceKey,
        attemptCount: workClaim.attemptCount,
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
        await opened.mark.failed(core.id, error);
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
    let workAdmissionAcknowledged = false;

    async function admitWork(): Promise<WorkClaim> {
      if (executionSignal.aborted) {
        throw (
          executionSignal.reason ??
          new AppError({
            code: "agent.session_aborted",
            message: "Work admission aborted",
            context: { workItemId: item.id },
          })
        );
      }
      const result = await opened.mark.beginAttempt(item.id, maxAttempts(spec.cfg));
      if (result.kind === "exhausted") {
        throw new AppError({
          code: "agent_work.attempts_exhausted",
          message: `Work item ${item.id} exhausted its ${maxAttempts(spec.cfg)} attempts`,
          context: {
            workItemId: item.id,
            attemptCount: result.attemptCount,
            maxAttempts: maxAttempts(spec.cfg),
          },
        });
      }
      if (result.kind === "unavailable") {
        if (await recheckSkippableAndCancel("start_rejected")) {
          throw new AppError({
            code: "agent.session_aborted",
            message: "Work admission cancelled or fenced",
            context: { workItemId: item.id },
          });
        }
        throw new AppError({
          code: "agent_work.admission_unavailable",
          message: "Work admission unavailable",
          context: { workItemId: item.id },
        });
      }
      workClaim = { ...result.claim, resumed };
      workAdmissionAcknowledged = true;
      if (executionSignal.aborted) {
        throw (
          executionSignal.reason ??
          new AppError({
            code: "agent.session_aborted",
            message: "Work admission aborted",
            context: { workItemId: item.id },
          })
        );
      }
      return workClaim;
    }

    const cancelIfSkippable = async (reason: string, notifyHook = true) => {
      if (isSkipCheckSuppressed(phaseState)) return false;
      // A newer execution owns the lease — exit without terminalising its work item.
      if (!(await opened.owns())) {
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
        await markCancelledAndInvokeHook(item, reason, seededInstallation);
      } else {
        await opened.mark.cancelled(item.id);
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
      if (
        await isBotCommenter(
          runtime.installationSurface,
          spec.cfg,
          spec.contextPolicy.commenterId(item),
        )
      ) {
        await markCancelledAndInvokeHook(item, "bot_commenter", installationToken);
        return undefined;
      }

      const prSurface = await runtime.installationSurface.create({
        cfg: spec.cfg,
        installationId: item.installationId,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        installation: installationToken,
        mutationBoundary: opened.mutationBoundary(item),
      });
      const resolvedHead = await spec.resolveHeadSha(prSurface, item);
      const headSha = resolvedHead.headSha;
      if (await opened.mark.headSha(item.id, headSha)) {
        boundHeadSha = headSha;
        executionPrSurface = prSurface;
        return createDurableExecutionContext({
          pool: spec.pool,
          item,
          job: spec.job,
          prSurface,
          headSha,
          pullRequest: resolvedHead.pullRequest,
          leaseEpoch,
          signal: executionSignal,
          beginAttempt: admitWork,
          getClaim: () => workClaim,
          getEscalation: () =>
            workAdmissionAcknowledged && workClaim
              ? escalationForAttempt(workClaim.attemptCount, spec.cfg)
              : undefined,
        });
      }

      await recheckSkippableAndCancel("head_update_rejected");
      return undefined;
    }

    async function completeRescheduledResult(
      result: Extract<DurableExecutionResult, { kind: "rescheduled" }>,
    ): Promise<void> {
      opened.requireLeaseEpoch(item.id);
      await result.afterComplete(spec.boss);
      await finishRescheduledParentWorkItem(
        opened,
        item.id,
        spec.type,
        result.replacementWorkItemId,
        spec.pool,
      );
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

    async function recordCompletion(completion: WorkCompletion): Promise<void> {
      // Analytics must not turn a committed completion into another lifecycle attempt.
      try {
        const ci = await loadCiWorkTelemetry(spec.pool, item.owner, item.repo, item.headSha);
        recordWorkCompleted({
          item,
          workType: spec.type,
          completion,
          ci,
          durationMs: durationMsFromClaim(workClaim),
          attemptCount: workClaim?.attemptCount ?? item.attemptCount,
        });
      } catch (error) {
        logWarn("agent_work_completion_telemetry_failed", {
          type: spec.type,
          workItemId: item.id,
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
          if (degradation.length) await opened.mark.degraded(item.id);
          if (!(await opened.mark.completed(item.id))) {
            await recheckSkippableAndCancel("completion_race", false);
            return;
          }
          if (result.completion) await recordCompletion(result.completion);
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
      if (await opened.mark.retrying(item.id, error)) {
        const failure = classifyFailure(error);
        logWarn("agent_work_retrying", {
          type: spec.type,
          workItemId: item.id,
          message,
          providerErrorKind: classifyProviderError(error),
          pgBossRetryCount: spec.job.retryCount,
          pgBossRetryLimit: spec.job.retryLimit,
          dbAttemptCount: attemptCount,
          retryPhase: workAdmissionAcknowledged ? "admitted_work" : "pre_admission",
          workAdmissionAcknowledged,
          ...classifiedFailureLogFields(failure),
        });
        // The next delivery re-reads the row; report the plan it will carry so escalation
        // rate is observable without reading transcripts.
        if (workAdmissionAcknowledged) {
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
        }
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
      // A surface that cannot be built must not hide hook steps that need no
      // surface (review cancels its stale-head replacement first); hooks see undefined.
      let prSurface: PrSurface | undefined;
      try {
        prSurface = executionPrSurface ?? (await prSurfaceForHooks(item));
      } catch (surfaceError) {
        logWarn("agent_work_terminal_failure_hook_failed", {
          type: spec.type,
          workItemId: item.id,
          message: surfaceError instanceof Error ? surfaceError.message : String(surfaceError),
        });
      }
      try {
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
        (!workAdmissionAcknowledged || attemptCount < maxAttempts(spec.cfg)) &&
        spec.job.retryCount < spec.job.retryLimit;
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

      if (!(await opened.mark.failed(item.id, error))) {
        await recheckSkippableAndCancel("failure_race");
        return;
      }
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
          dbAttemptCount: attemptCount,
          skipAnalyticsException: true,
          ...errorLogFields(error),
          ...classifiedFailureLogFields(failure),
        },
        error,
      );
      await recordCompletion({
        kind: "failure",
        failure: workFailureReasonFromClassified(failure),
      });
    }

    try {
      if (jobSignal.aborted) {
        await markCancelledAndInvokeHook(item, "job_aborted", seededInstallation);
        return;
      }
      if (!(await opened.owns())) {
        // A newer execution owns the lease — do not terminalise its work item.
        logInfo("agent_work_stale_execution_skipped", {
          type: spec.type,
          workItemId: item.id,
          leaseEpoch,
        });
        return;
      }
      seededInstallation = await runtime.installationSurface.token(spec.cfg, item.installationId);
      const execution = await prepareDurableExecution(seededInstallation);
      if (!execution) return;

      logInfo("agent_work_started", {
        type: spec.type,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        leaseEpoch,
      });
      await reconcilePendingIntents(spec.pool, item.id, leaseEpoch);
      if (!(await opened.owns())) {
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
      opened.observeCancellation();
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
    await opened.release();
  }
}
