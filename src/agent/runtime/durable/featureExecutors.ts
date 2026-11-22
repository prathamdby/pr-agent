import type { Context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import * as v from "valibot";
import {
  captureWorkTerminal,
  durationMsFromClaim,
  recordWorkCompleted,
  workFailureReasonFromClassified,
  type WorkCompletion,
} from "../../../analytics/workCompleted.ts";
import { createAskFeatureExecution } from "../../../agentWork/executors/askExecutor.ts";
import { runAckJob, parseAckPayload } from "../../../agentWork/executors/ackExecutor.ts";
import { runCiProjectionJob } from "../../../agentWork/executors/ciProjectionExecutor.ts";
import { createDescriptionFeatureExecution } from "../../../agentWork/executors/descriptionExecutor.ts";
import {
  passthroughMutationBoundary,
  publishReactions,
  resolveInstallationPolicy,
} from "../../../agentWork/executors/featureCapabilities.ts";
import type {
  FeatureExecutionEnv,
  FeatureSessionFactory,
  FeatureWorkDependencies,
  FeatureWorkExecution,
  ReviewSurfacePublisher,
} from "../../../agentWork/executors/featureExecution.ts";
import { createTriageFeatureExecution } from "../../../agentWork/executors/triageExecutor.ts";
import { createVerificationFeatureExecution } from "../../../agentWork/executors/verificationExecutor.ts";
import { loadCiWorkTelemetryFromState } from "../../../agentWork/ciWorkTelemetry.ts";
import { reactionTargetsForWorkItem } from "../../../agentWork/reactionTargets.ts";
import { escalationForAttempt, maxAttempts } from "../../../agentWork/retryPolicy.ts";
import type { AgentWorkItem, CiProjectionJobData, WorkType } from "../../../agentWork/types.ts";
import { attachWorkItemPayload } from "../../../agentWork/workItemPayloadSchema.ts";
import { classifyFailure, classifiedFailureLogFields } from "../../../errors/classifiedFailure.ts";
import { errorMessage } from "../../../errors/errorMessage.ts";
import { logError, logInfo, logWarn } from "../../../evlog.ts";
import type { PrSurface } from "../../../github/prSurface.ts";
import { withPrRepositoryView } from "../../../prWorkspace/prRepositoryView.ts";
import { sanitizeLogMessage } from "../../../security/sanitizeLogMessage.ts";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
} from "../../../settings/index.ts";
import { immediate } from "../../../state/db.ts";
import {
  createFeaturePublication,
  type FeaturePublication,
} from "../../../state/featurePublication.ts";
import { enqueueDueCiProjections } from "../../../state/prHeadCiState.ts";
import { cancelWorkRun, type WorkRunAttemptRow, type WorkRunRow } from "../../../state/workRuns.ts";
import { startWorkTrace } from "../../../traces/recorder.ts";
import { attachReportObstacle } from "../../feedback/reportObstacle.ts";
import { isCancelAbortError } from "../../providers/providerErrors.ts";
import { createFeaturePiSession } from "../createFeatureSession.ts";
import { modelAssignmentForRole, resolveModelPolicy } from "../modelPolicy.ts";
import type { FeatureAttemptExecutor, FeatureAttemptExecutorFor } from "./featureAttemptTask.ts";
import type { AckHandler } from "./dispatcher.ts";
import type { WorkerDeps } from "./workerDeps.ts";

type LaneWorkType = Exclude<WorkType, "review">;

const runPayloadBaseSchema = v.looseObject({
  installationId: v.number(),
  owner: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  headSha: v.string(),
  webhookEventId: v.optional(v.string()),
  repositorySizeKb: v.optional(v.number()),
  webhookReceivedAt: v.optional(v.number()),
});

const ciProjectionPayloadSchema = v.looseObject({
  installationId: v.number(),
  owner: v.string(),
  repo: v.string(),
  headSha: v.string(),
  webhookEventId: v.optional(v.string()),
  delivery: v.optional(v.string()),
});

function coreFromRun(run: WorkRunRow, attemptNo: number) {
  const raw: unknown = JSON.parse(run.payload_json);
  const base = v.parse(runPayloadBaseSchema, raw);
  const source = v.is(v.object({ source: v.literal("slash") }), raw) ? "slash" : "auto";
  return ((pinnedReturn: {
    readonly raw: unknown;
    readonly source: "auto" | "slash";
    readonly webhookReceivedAt?: number;
    readonly core: RunCore;
  }) => pinnedReturn)({
    raw,
    source,
    ...(base.webhookReceivedAt !== undefined ? { webhookReceivedAt: base.webhookReceivedAt } : {}),
    core: {
      id: run.work_id,
      installationId: base.installationId,
      owner: base.owner,
      repo: base.repo,
      prNumber: base.prNumber,
      headSha: base.headSha,
      ...(base.repositorySizeKb !== undefined ? { repositorySizeKb: base.repositorySizeKb } : {}),
      webhookEventId: base.webhookEventId ?? null,
      status: "running",
      resourceKey: run.pr_key,
      attemptCount: attemptNo,
      cancelRequestedAt: null,
      reviewLens: null,
    },
  });
}

type RunCore = Omit<Extract<AgentWorkItem, { type: "ask" }>, "type" | "source" | "payload">;

type ItemFromRun<T extends LaneWorkType> = (
  core: RunCore,
  raw: unknown,
  source: "auto" | "slash",
) => Extract<AgentWorkItem, { type: T }>;

function commenterIdFor(item: AgentWorkItem) {
  switch (item.type) {
    case "ask":
    case "description":
    case "triage":
    case "review":
      return ((pinnedReturn: number | undefined) => pinnedReturn)(item.payload.commenterId);
    case "verification":
      return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
  }
  return ((pinnedReturn: number | undefined) => pinnedReturn)(undefined);
}

async function resolveAttemptTaskId(deps: WorkerDeps, taskId: string, context: Context) {
  const page = await deps.runtime.handle.harness.commit(
    (tx) => tx.scanTasks({ kind: "pr.feature_attempt", status: "running" }, 512),
    context,
  );
  const found: TaskId | undefined = page.items.find((record) => String(record.id) === taskId)?.id;
  return found;
}

function taskOwnedSessionFactory(params: {
  readonly deps: WorkerDeps;
  readonly item: AgentWorkItem;
  readonly attemptNo: number;
  readonly taskId: string;
  readonly context: Context;
  readonly signal: AbortSignal;
}) {
  const { deps, item } = params;
  let ownerTask: Promise<TaskId | undefined> | undefined;
  const factory: FeatureSessionFactory = async (session) => {
    ownerTask ??= resolveAttemptTaskId(deps, params.taskId, params.context);
    const taskId = await ownerTask;
    const primary =
      session.attemptModel ?? modelAssignmentForRole(resolveModelPolicy(deps.cfg), session.role);
    const attached = attachReportObstacle(
      { tools: session.tools, executors: session.executors },
      {
        db: deps.db,
        workItemId: item.id,
        installationId: item.installationId,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        attemptCount: params.attemptNo,
        sessionRole: session.role,
        ...(session.specialistId ? { specialistId: session.specialistId } : {}),
        provider: primary.provider,
        model: primary.model,
      },
    );
    if (taskId === undefined) {
      logWarn("feature_session_task_owner_missing", { workItemId: item.id, taskId: params.taskId });
    }
    return (deps.createSession ?? createFeaturePiSession)({
      ...session,
      tools: attached.tools,
      executors: attached.executors,
      ...(taskId !== undefined ? { ownership: { kind: "task", taskId } } : {}),
      hostSignal: session.hostSignal ?? params.signal,
    });
  };
  return factory;
}

function featureWorkDependencies(deps: WorkerDeps) {
  return ((pinnedReturn: FeatureWorkDependencies) => pinnedReturn)({
    cfg: deps.cfg,
    botIdentity: () => deps.installationSurface.botIdentity(deps.cfg),
  });
}

function publicationFor(
  deps: WorkerDeps,
  run: WorkRunRow,
  signal: AbortSignal | undefined,
  now: () => number,
) {
  return ((pinnedReturn: FeaturePublication) => pinnedReturn)(
    createFeaturePublication({
      db: deps.db,
      workId: run.work_id,
      prKey: run.pr_key,
      laneEpoch: run.lane === "none" ? null : run.lane_epoch,
      shutdownRequested: deps.shutdownRequested,
      ...(signal !== undefined ? { signal } : {}),
      now,
    }),
  );
}

function recordCompletion(params: {
  readonly deps: WorkerDeps;
  readonly item: AgentWorkItem;
  readonly attempt: WorkRunAttemptRow;
  readonly completion: WorkCompletion;
  readonly webhookReceivedAt?: number;
}) {
  const { item } = params;
  try {
    recordWorkCompleted({
      item,
      workType: item.type,
      completion: params.completion,
      ci: loadCiWorkTelemetryFromState(params.deps.db, item.owner, item.repo, item.headSha),
      durationMs: durationMsFromClaim(
        params.attempt.started_at == null
          ? null
          : { startedAt: new Date(params.attempt.started_at) },
      ),
      attemptCount: params.attempt.attempt_no,
      ...(params.webhookReceivedAt != null ? { webhookReceivedAt: params.webhookReceivedAt } : {}),
    });
  } catch (error) {
    logWarn("agent_work_completion_telemetry_failed", {
      type: item.type,
      workItemId: item.id,
      message: sanitizeLogMessage(errorMessage(error)),
    });
  }
}

async function runLaneFeature<T extends LaneWorkType>(
  deps: WorkerDeps,
  type: T,
  execution: FeatureWorkExecution<T>,
  toItem: ItemFromRun<T>,
  ctx: Parameters<FeatureAttemptExecutor>[0],
) {
  const now = deps.now ?? Date.now;
  const { run, attempt, signal } = ctx;
  const parsed = coreFromRun(run, attempt.attempt_no);
  const typed = toItem(parsed.core, parsed.raw, parsed.source);
  const item: AgentWorkItem = typed;
  const publication = publicationFor(deps, run, signal, now);
  const commenterId = commenterIdFor(item);
  if (commenterId != null) {
    const bot = await deps.installationSurface.botIdentity(deps.cfg);
    if (bot.userId === commenterId) {
      immediate(deps.db, () =>
        cancelWorkRun(deps.db, { workId: run.work_id, reason: "bot_commenter", now: now() }),
      );
      captureWorkTerminal({
        workItemId: item.id,
        installationId: item.installationId,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha: item.headSha,
        workType: type,
        outcome: "cancelled",
        reason: "bot_commenter",
        source: "worker",
        executionId: attempt.attempt_id,
        attemptCount: attempt.attempt_no,
      });
      return;
    }
  }
  const scope = { installationId: item.installationId, owner: item.owner, repo: item.repo };
  const policy = await resolveInstallationPolicy({
    db: deps.db,
    cfg: deps.cfg,
    installationSurface: deps.installationSurface,
    scope,
    signal,
    now,
  });
  const installation =
    policy.installation ??
    (await deps.installationSurface.scopedToken({ cfg: deps.cfg, ...scope }));
  const prSurface: PrSurface = await deps.installationSurface.create({
    cfg: deps.cfg,
    ...scope,
    prNumber: item.prNumber,
    installation,
    capabilities: policy.capabilities,
    mutationBoundary: passthroughMutationBoundary(signal),
  });
  const resolved =
    item.headSha === DEFERRED_HEAD_SHA ? await prSurface.getHead() : { headSha: item.headSha };
  const headSha = resolved.headSha;
  const hookItem = headSha === item.headSha ? typed : { ...typed, headSha };
  const createSession = taskOwnedSessionFactory({
    deps,
    item,
    attemptNo: attempt.attempt_no,
    taskId: ctx.taskId,
    context: ctx.context,
    signal,
  });
  const escalation = escalationForAttempt(attempt.attempt_no, deps.cfg);
  const env: FeatureExecutionEnv = {
    db: deps.db,
    cfg: deps.cfg,
    publication,
    prSurface,
    headSha,
    ...("pullRequest" in resolved ? { pullRequest: resolved.pullRequest } : {}),
    signal,
    attemptNo: attempt.attempt_no,
    ...(escalation !== undefined ? { escalation } : {}),
    createSession,
    withRepositoryView: (options, runView) =>
      withPrRepositoryView(
        {
          ...options,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          headSha,
          ...("pullRequest" in resolved ? { pullRequest: resolved.pullRequest } : {}),
          gitCredentialAuth: () => prSurface.gitCredentialAuth(),
        },
        runView,
      ),
    shouldAbortPublish: async () => !publication.current(),
  };
  logInfo("agent_work_started", { type, workItemId: item.id, resourceKey: item.resourceKey });
  try {
    const result = await startWorkTrace(
      {
        executionId: attempt.attempt_id,
        workItemId: item.id,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        headSha,
        installationId: item.installationId,
        provider: deps.cfg.models.provider,
        model: deps.cfg.models.model,
      },
      () => execution.execute(hookItem, env),
    );
    if (!publication.current()) return;
    if (result.completion !== undefined) {
      recordCompletion({
        deps,
        item,
        attempt,
        completion: result.completion,
        ...(parsed.webhookReceivedAt !== undefined
          ? { webhookReceivedAt: parsed.webhookReceivedAt }
          : {}),
      });
    }
    logInfo("agent_work_completed", { type, workItemId: item.id });
    await publishReactions({
      publication,
      prSurface,
      targets: reactionTargetsForWorkItem(item),
      content: GITHUB_REACTION_PLUS_ONE,
      logEvent: "agent_work_outcome_reaction_failed",
      logFields: { type, workItemId: item.id },
    });
  } catch (error) {
    if (isCancelAbortError(error) || signal.aborted || !publication.current()) throw error;
    if (attempt.attempt_no < maxAttempts(deps.cfg)) throw error;
    try {
      await execution.onTerminalFailure?.(hookItem, prSurface, {
        db: deps.db,
        cfg: deps.cfg,
        publication,
      });
    } catch (hookError) {
      logWarn("agent_work_terminal_failure_hook_failed", {
        type,
        workItemId: item.id,
        message: errorMessage(hookError),
      });
    }
    await publishReactions({
      publication,
      prSurface,
      targets: reactionTargetsForWorkItem(item),
      content: GITHUB_REACTION_MINUS_ONE,
      logEvent: "agent_work_outcome_reaction_failed",
      logFields: { type, workItemId: item.id },
    });
    const failure = classifyFailure(error);
    logError(
      "agent_work_failed",
      {
        type,
        workItemId: item.id,
        installationId: item.installationId,
        owner: item.owner,
        repo: item.repo,
        pr_number: item.prNumber,
        message: sanitizeLogMessage(errorMessage(error)),
        dbAttemptCount: attempt.attempt_no,
        skipAnalyticsException: true,
        ...classifiedFailureLogFields(failure),
      },
      error,
    );
    recordCompletion({
      deps,
      item,
      attempt,
      completion: { kind: "failure", failure: workFailureReasonFromClassified(failure) },
    });
    throw error;
  }
}

function parseCiProjectionPayload(payloadJson: string) {
  const parsed = v.parse(ciProjectionPayloadSchema, JSON.parse(payloadJson));
  return ((pinnedReturn: CiProjectionJobData) => pinnedReturn)({
    kind: "ci_projection",
    installationId: parsed.installationId,
    owner: parsed.owner,
    repo: parsed.repo,
    headSha: parsed.headSha,
    ...(parsed.webhookEventId !== undefined ? { webhookEventId: parsed.webhookEventId } : {}),
    ...(parsed.delivery !== undefined ? { delivery: parsed.delivery } : {}),
  });
}

export function createFeatureExecutors(deps: WorkerDeps, reviewPublisher?: ReviewSurfacePublisher) {
  const workDeps = featureWorkDependencies(deps);
  const ask = createAskFeatureExecution(workDeps);
  const description = createDescriptionFeatureExecution(workDeps);
  const triage = createTriageFeatureExecution(workDeps);
  const verification = createVerificationFeatureExecution(workDeps);
  const ciProjection: FeatureAttemptExecutor = async (ctx) => {
    const now = deps.now ?? Date.now;
    await runCiProjectionJob(
      {
        db: deps.db,
        cfg: deps.cfg,
        installationSurface: deps.installationSurface,
        publication: publicationFor(deps, ctx.run, ctx.signal, now),
        ...(reviewPublisher !== undefined ? { reviewPublisher } : {}),
        createSession: async (session) =>
          (deps.createSession ?? createFeaturePiSession)({
            ...session,
            hostSignal: session.hostSignal ?? ctx.signal,
          }),
        now,
      },
      parseCiProjectionPayload(ctx.run.payload_json),
    );
  };
  const executors: Record<LaneWorkType | "ci_projection", FeatureAttemptExecutor> = {
    ask: (ctx) =>
      runLaneFeature(
        deps,
        "ask",
        ask,
        (core, raw) => attachWorkItemPayload({ ...core, type: "ask", source: "slash" }, raw),
        ctx,
      ),
    description: (ctx) =>
      runLaneFeature(
        deps,
        "description",
        description,
        (core, raw, source) => attachWorkItemPayload({ ...core, type: "description", source }, raw),
        ctx,
      ),
    triage: (ctx) =>
      runLaneFeature(
        deps,
        "triage",
        triage,
        (core, raw) => attachWorkItemPayload({ ...core, type: "triage", source: "slash" }, raw),
        ctx,
      ),
    verification: (ctx) =>
      runLaneFeature(
        deps,
        "verification",
        verification,
        (core, raw, source) =>
          attachWorkItemPayload({ ...core, type: "verification", source }, raw),
        ctx,
      ),
    ci_projection: ciProjection,
  };
  const executorFor: FeatureAttemptExecutorFor = (kind) => executors[kind];
  return executorFor;
}

export function createAckHandler(deps: WorkerDeps, reviewPublisher?: ReviewSurfacePublisher) {
  const handler: AckHandler = async (claim) => {
    const now = deps.now ?? Date.now;
    await runAckJob(
      {
        db: deps.db,
        cfg: deps.cfg,
        installationSurface: deps.installationSurface,
        publication: publicationFor(deps, claim.run, undefined, now),
        ...(reviewPublisher !== undefined ? { reviewPublisher } : {}),
        now,
      },
      parseAckPayload(claim.run.payload_json),
    );
  };
  return handler;
}

export function runDueCiProjections(deps: WorkerDeps, now: number) {
  return ((pinnedReturn: readonly string[]) => pinnedReturn)(enqueueDueCiProjections(deps.db, now));
}
