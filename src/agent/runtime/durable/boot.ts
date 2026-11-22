import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Task,
  type HarnessInspection,
  type TaskId,
} from "@earendil-works/pi-durable";
import * as v from "valibot";
import type { Config } from "../../../settings/index.ts";
import type { AppStateHandle } from "../../../state/db.ts";
import { immediate } from "../../../state/db.ts";
import { runRetention } from "../../../state/retention.ts";
import { sweepIntentRecoveries, sweepRecoverableIntents } from "../../../state/recoverIntents.ts";
import type { PublishIntentRow } from "../../../state/publish.ts";
import {
  cancelLiveAttempt,
  supersedeWorkRun,
  laneEpochCurrent,
  markAttemptRunning,
  markWorkRunCompleted,
  unfinishedAttempts,
  workRunById,
  type WorkRunAttemptRow,
  type WorkRunRow,
} from "../../../state/workRuns.ts";
import type { InstallationSurface } from "../../../agentWork/installationSurface.ts";
import { createIntentRecoveryPrSurface } from "../../../github/prSurface.ts";
import type { PrSurface } from "../../../github/prSurfaceTypes.ts";
import { errorMessage } from "../../../errors/errorMessage.ts";
import { logError, logInfo, logWarn } from "../../../evlog.ts";
import { unrefTimer } from "../../../util/unrefTimer.ts";
import {
  createDispatcher,
  pendingCiProjectionCount,
  type CiProjectionRunner,
  type Dispatcher,
  type AckHandler,
  type ResumedReview,
} from "./dispatcher.ts";
import {
  FEATURE_ATTEMPT_TASK_NAME,
  createFeatureAttemptTask,
  attemptStampSchema,
  startClaimedAttempt,
  type AttemptStamp,
  type FeatureAttemptExecutorFor,
  recordAttemptFailure,
} from "./featureAttemptTask.ts";
import { conversationIdFromText, taskIdFromText } from "./harness.ts";
import {
  maybeResetPiDurable,
  type PiDurableResetOutcome,
  type PiDurableResetReason,
} from "./durableReset.ts";
import { replaceSharedDurableRuntime, type DurableRuntime } from "./runtime.ts";
import type { WorkerDeps } from "./workerDeps.ts";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RESET_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RECOVERABLE_INTENT_SWEEP_INTERVAL_MS = 60 * 1000;

type LiveTask = HarnessInspection["tasks"][number]["record"];
type StoredOutcome = {
  readonly status: "completed" | "failed" | "faulted" | "aborted" | "orphaned";
  readonly error?: { readonly message: string };
  readonly reason?: string;
};

export type PhaseAResult = {
  readonly schedulingDuringPhaseA: readonly ("paused" | "running" | "closing")[];
  readonly intentSweep: { readonly swept: number; readonly reconciled: number } | undefined;
  readonly projected: number;
  readonly adopted: number;
  readonly interrupted: number;
  readonly cancelled: number;
  readonly toAbort: readonly TaskId[];
  readonly resumedReviews: readonly ResumedReview[];
  readonly pendingCiProjections: number;
};

function stampKey(workId: string, attemptNo: number) {
  return ((pinnedReturn: string) => pinnedReturn)(`${workId}#${String(attemptNo)}`);
}

function attemptStampOf(record: LiveTask) {
  const parsed = v.safeParse(attemptStampSchema, record.input);
  return ((pinnedReturn: v.InferOutput<typeof attemptStampSchema> | undefined) => pinnedReturn)(
    parsed.success ? parsed.output : undefined,
  );
}

function runIsCurrentFor(db: DatabaseSync, run: WorkRunRow | undefined, attemptNo: number) {
  return (
    run !== undefined &&
    run.status === "running" &&
    run.cancel_reason === null &&
    run.current_attempt_no === attemptNo &&
    laneEpochCurrent(db, run)
  );
}

function workRunSurfaceRef(run: WorkRunRow) {
  const parsed = v.safeParse(
    v.looseObject({
      installationId: v.number(),
      owner: v.string(),
      repo: v.string(),
      prNumber: v.number(),
    }),
    JSON.parse(run.payload_json),
  );
  return ((
    pinnedReturn:
      | { installationId: number; owner: string; repo: string; prNumber: number }
      | undefined,
  ) => pinnedReturn)(parsed.success ? parsed.output : undefined);
}

export function intentSurfaceFromWorkRuns(params: {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly installationSurface: InstallationSurface;
}) {
  return (intent: PublishIntentRow) => {
    const run = workRunById(params.db, intent.work_id);
    const ref = run === undefined ? undefined : workRunSurfaceRef(run);
    if (ref === undefined)
      return ((pinnedReturn: PrSurface | undefined) => pinnedReturn)(undefined);
    return ((pinnedReturn: PrSurface | undefined) => pinnedReturn)(
      createIntentRecoveryPrSurface({
        cfg: params.cfg,
        installationId: ref.installationId,
        owner: ref.owner,
        repo: ref.repo,
        prNumber: ref.prNumber,
        tokenResolver: () => params.installationSurface.scopedToken({ cfg: params.cfg, ...ref }),
      }),
    );
  };
}

function projectTerminalOutcome(
  db: DatabaseSync,
  cfg: Config,
  attempt: WorkRunAttemptRow,
  outcome: StoredOutcome,
  now: number,
) {
  if (outcome.status === "completed") {
    immediate(db, () =>
      markWorkRunCompleted(db, {
        workId: attempt.work_id,
        attemptNo: attempt.attempt_no,
        now,
      }),
    );
    return;
  }
  recordAttemptFailure(db, cfg, {
    workId: attempt.work_id,
    attemptNo: attempt.attempt_no,
    error: new Error(
      outcome.status === "failed" || outcome.status === "faulted"
        ? (outcome.error?.message ?? `durable task ${outcome.status}`)
        : `durable task ${outcome.status}: ${outcome.reason ?? ""}`,
    ),
    interrupted: outcome.status === "aborted" || outcome.status === "orphaned",
    now,
  });
}

export async function runBootPhaseA(params: {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly runtime: DurableRuntime;
  readonly reviewTaskName: string;
  readonly surfaceFor?: (intent: PublishIntentRow) => PrSurface | undefined;
  readonly context?: Context;
  readonly now?: () => number;
}) {
  const { db, cfg } = params;
  const context = params.context ?? BACKGROUND_CONTEXT;
  const now = params.now ?? Date.now;
  const harness = params.runtime.handle.harness;
  const scheduling: ("paused" | "running" | "closing")[] = [];
  const observe = async () => {
    const inspection = await harness.inspect(context);
    scheduling.push(inspection.scheduling);
    return inspection;
  };

  let intentSweep: PhaseAResult["intentSweep"];
  if (params.surfaceFor !== undefined) {
    try {
      intentSweep = await sweepIntentRecoveries(db, { surfaceFor: params.surfaceFor, now: now() });
    } catch (error) {
      logWarn("boot_intent_sweep_failed", { message: errorMessage(error) });
    }
  }

  const inspection = await observe();
  const attemptKinds = new Set([FEATURE_ATTEMPT_TASK_NAME, params.reviewTaskName]);
  const liveByStamp = new Map<string, LiveTask>();
  for (const task of inspection.tasks) {
    if (!attemptKinds.has(task.record.kind) || task.record.owner !== undefined) continue;
    const stamp = attemptStampOf(task.record);
    if (stamp !== undefined) liveByStamp.set(stampKey(stamp.workId, stamp.attemptNo), task.record);
  }

  const toAbort: TaskId[] = [];
  const resumedReviews: ResumedReview[] = [];
  const handled = new Set<string>();
  let projected = 0;
  let adopted = 0;
  let interrupted = 0;
  let cancelled = 0;

  const interrupt = (attempt: WorkRunAttemptRow, reason: string) => {
    recordAttemptFailure(db, cfg, {
      workId: attempt.work_id,
      attemptNo: attempt.attempt_no,
      error: new Error(reason),
      interrupted: true,
      now: now(),
    });
    interrupted += 1;
  };

  for (const attempt of unfinishedAttempts(db)) {
    const key = stampKey(attempt.work_id, attempt.attempt_no);
    const record = liveByStamp.get(key);
    if (attempt.task_id === null) {
      if (record === undefined) {
        interrupt(attempt, "attempt interrupted before its durable task was recorded");
        continue;
      }
      const live = record;
      const marked = immediate(db, () =>
        markAttemptRunning(db, {
          workId: attempt.work_id,
          attemptNo: attempt.attempt_no,
          conversationId: String(live.conversationId),
          taskId: String(live.id),
          now: now(),
        }),
      );
      if (marked === 0) {
        handled.add(key);
        toAbort.push(live.id);
        cancelled += 1;
        continue;
      }
      adopted += 1;
    } else if (record === undefined) {
      const storedId = taskIdFromText(attempt.task_id);
      const stored = storedId === undefined ? undefined : await harness.getTask(storedId, context);
      if (stored !== undefined && stored.state.status === "terminal") {
        projectTerminalOutcome(db, cfg, attempt, stored.state.outcome, now());
        projected += 1;
        continue;
      }
      interrupt(attempt, "attempt durable task is missing after restart");
      continue;
    }
    if (record === undefined) continue;
    handled.add(key);
    const run = workRunById(db, attempt.work_id);
    if (!runIsCurrentFor(db, run, attempt.attempt_no)) {
      immediate(db, () => {
        if (
          run?.status === "running" &&
          run.current_attempt_no === attempt.attempt_no &&
          !laneEpochCurrent(db, run)
        )
          supersedeWorkRun(db, { workId: run.work_id, now: now() });
        else
          cancelLiveAttempt(db, {
            workId: attempt.work_id,
            attemptNo: attempt.attempt_no,
            now: now(),
          });
      });
      toAbort.push(record.id);
      cancelled += 1;
      continue;
    }
    if (record.kind === FEATURE_ATTEMPT_TASK_NAME || run === undefined) {
      interrupt(attempt, "feature attempt interrupted by restart");
      toAbort.push(record.id);
      continue;
    }
    resumedReviews.push({ prKey: run.pr_key, taskId: record.id });
  }

  for (const [key, record] of liveByStamp) {
    if (!handled.has(key)) toAbort.push(record.id);
  }

  const pendingCiProjections = pendingCiProjectionCount(db);
  await observe();
  return ((pinnedReturn: PhaseAResult) => pinnedReturn)({
    schedulingDuringPhaseA: scheduling,
    intentSweep,
    projected,
    adopted,
    interrupted,
    cancelled,
    toAbort,
    resumedReviews,
    pendingCiProjections,
  });
}

export async function runBootPhaseB(params: {
  readonly runtime: DurableRuntime;
  readonly phaseA: PhaseAResult;
  readonly dispatcher: Dispatcher;
  readonly context?: Context;
}) {
  const context = params.context ?? BACKGROUND_CONTEXT;
  const harness = params.runtime.handle.harness;
  for (const taskId of params.phaseA.toAbort) {
    await harness.abortTask(taskId, context);
  }
  params.runtime.handle.resume();
  for (const review of params.phaseA.resumedReviews) {
    params.dispatcher.trackResumedReview(review);
  }
  params.dispatcher.start();
}

export type DurableService = {
  readonly deps: WorkerDeps;
  readonly dispatcher: Dispatcher;
  readonly phaseA: PhaseAResult;
  readonly acceptingWebhooks: () => boolean;
  readonly ready: () => boolean;
  readonly afterIntakeCommit: (conversationsToAbort: readonly string[]) => void;
  readonly checkReset: (force?: PiDurableResetReason) => Promise<PiDurableResetOutcome>;
  readonly shutdown: (reason: string, exitCode?: number) => Promise<void>;
  readonly exited: Promise<number>;
};

export async function startDurableService<S extends { phase: string }, R>(params: {
  readonly appState: AppStateHandle;
  readonly cfg: Config;
  readonly runtime: DurableRuntime;
  readonly reopenRuntime: () => Promise<DurableRuntime>;
  readonly installationSurface: InstallationSurface;
  readonly createHandlers: (deps: WorkerDeps) => {
    readonly ack: AckHandler;
    readonly feature: FeatureAttemptExecutorFor;
    readonly review: {
      readonly task: Task<AttemptStamp, S, R, object>;
      readonly restore: (id: TaskId, context: Context) => Promise<boolean>;
      readonly close: () => Promise<void>;
    };
  };
  readonly createCiProjectionRunner?: (deps: WorkerDeps) => CiProjectionRunner;
  readonly surfaceFor?: (intent: PublishIntentRow) => PrSurface | undefined;
  readonly context?: Context;
  readonly now?: () => number;
  readonly intervals?: {
    readonly retentionMs?: number;
    readonly resetCheckMs?: number;
    readonly intentSweepMs?: number;
    readonly dispatcherIdleWakeMs?: number;
  };
}) {
  const { cfg } = params;
  const db = params.appState.db;
  const context = params.context ?? BACKGROUND_CONTEXT;
  const now = params.now ?? Date.now;
  let runtime = params.runtime;
  let shutdownRequested = false;
  let harnessClosed = false;
  let resetting = false;
  let shutdownPromise: Promise<void> | undefined;
  const expectedClose = new WeakSet<DurableRuntime>();
  const timers: ReturnType<typeof setInterval>[] = [];
  const exitResolvers: ((code: number) => void)[] = [];
  const exited = new Promise<number>((resolve) => {
    exitResolvers.push(resolve);
  });

  const deps: WorkerDeps = {
    db,
    get runtime() {
      return runtime;
    },
    cfg,
    installationSurface: params.installationSurface,
    shutdownRequested: () => shutdownRequested,
    now,
  };

  const watchClosed = (watched: DurableRuntime) => {
    void watched.handle.closed.then((end) => {
      if (watched !== runtime) return;
      harnessClosed = true;
      if (expectedClose.has(watched)) return;
      logError("pi_durable_closed_unexpectedly", {
        kind: end.kind,
        ...(end.kind === "failed" ? { message: errorMessage(end.error) } : {}),
      });
      void shutdown("pi_durable_closed", 1);
    });
  };

  const handlers = params.createHandlers(deps);
  const featureTask = createFeatureAttemptTask({ db, cfg, executorFor: handlers.feature, now });
  const tasks = defineExtension({
    name: "pr-work-runs",
    tasks: [handlers.review.task, featureTask],
  });
  runtime.registry.install(tasks);
  const dispatcher = createDispatcher({
    db,
    cfg,
    ack: handlers.ack,
    startAttempt: async (claim) => {
      const admission = { harness: runtime.handle.harness, context, db, claim, now: now() };
      const started =
        claim.run.kind === "review"
          ? await startClaimedAttempt(handlers.review.task, admission)
          : await startClaimedAttempt(featureTask, admission);
      return started.markedRunning ? started.taskId : undefined;
    },
    runtime: () => runtime,
    context,
    now,
    ...(params.intervals?.dispatcherIdleWakeMs !== undefined
      ? { idleWakeMs: params.intervals.dispatcherIdleWakeMs }
      : {}),
  });
  const ciRunner = params.createCiProjectionRunner?.(deps);

  const boot = async () => {
    const inspection = await runBootPhaseA({
      db,
      cfg,
      runtime,
      reviewTaskName: handlers.review.task.definition.name,
      ...(params.surfaceFor !== undefined ? { surfaceFor: params.surfaceFor } : {}),
      context,
      now,
    });
    const resumedReviews: ResumedReview[] = [];
    const toAbort = [...inspection.toAbort];
    for (const review of inspection.resumedReviews) {
      if (await handlers.review.restore(review.taskId, context)) resumedReviews.push(review);
      else toAbort.push(review.taskId);
    }
    const phaseA = {
      ...inspection,
      resumedReviews,
      toAbort,
      interrupted: inspection.interrupted + toAbort.length - inspection.toAbort.length,
    };
    logInfo("boot_phase_a", {
      projected: phaseA.projected,
      adopted: phaseA.adopted,
      interrupted: phaseA.interrupted,
      cancelled: phaseA.cancelled,
      toAbort: phaseA.toAbort.length,
      resumedReviews: phaseA.resumedReviews.length,
      pendingCiProjections: phaseA.pendingCiProjections,
    });
    if (ciRunner !== undefined) dispatcher.setCiProjectionRunner(ciRunner);
    await runBootPhaseB({ runtime, phaseA, dispatcher, context });
    return phaseA;
  };
  const phaseA = await boot().catch(async (error: unknown) => {
    await runtime.handle.harness.close(context);
    await handlers.review.close();
    throw error;
  });

  let retaining: Promise<void> | undefined;
  const runRetentionOnce = async () => {
    if (!cfg.retention.enabled || shutdownRequested) return;
    try {
      const result = await runRetention(db, cfg, now());
      logInfo("retention_completed", { ...result });
    } catch (error) {
      logWarn("retention_failed", { message: errorMessage(error) });
    }
  };

  let resetChain: Promise<unknown> = Promise.resolve();
  const checkReset = (force?: PiDurableResetReason) => {
    const next = resetChain.then(() => runResetCheck(force));
    resetChain = next.catch(() => undefined);
    return ((pinnedReturn: Promise<PiDurableResetOutcome>) => pinnedReturn)(next);
  };

  const runResetCheck = async (force?: PiDurableResetReason) => {
    if (shutdownRequested)
      return ((pinnedReturn: PiDurableResetOutcome) => pinnedReturn)({ kind: "skipped" });
    resetting = true;
    try {
      const outcome = await maybeResetPiDurable({
        db,
        sqliteDir: cfg.runtime.sqliteDir,
        maxBytes: cfg.runtime.piDurableResetMaxBytes,
        maxAgeSeconds: cfg.runtime.piDurableResetMaxAgeSeconds,
        current: runtime,
        context,
        now,
        quiesceTimeoutMs: cfg.runtime.shutdownGraceMs,
        ...(force !== undefined ? { force } : {}),
        quiesce: async () => {
          await dispatcher.drain(cfg.runtime.shutdownGraceMs);
        },
        markExpectedClose: (closing) => {
          expectedClose.add(closing);
        },
        reopen: async () => {
          const next = await params.reopenRuntime();
          next.registry.install(tasks);
          runtime = next;
          harnessClosed = false;
          replaceSharedDurableRuntime(cfg, next);
          watchClosed(next);
          return next;
        },
        resumeUsers: () => {
          if (!shutdownRequested) dispatcher.start();
        },
      });
      if (outcome.kind === "reset") {
        logInfo("pi_durable_reset", { reason: outcome.reason, archiveDir: outcome.archiveDir });
      } else if (outcome.kind === "not_quiescent") {
        logWarn("pi_durable_reset_deferred", { ...outcome.detail });
      }
      return ((pinnedReturn: PiDurableResetOutcome) => pinnedReturn)(outcome);
    } catch (error) {
      logError("pi_durable_reset_failed", { message: errorMessage(error) });
      void shutdown("pi_durable_reset_failed", 1);
      throw error;
    } finally {
      resetting = false;
    }
  };

  const schedule = (ms: number, fn: () => void) => {
    const timer = setInterval(fn, ms);
    unrefTimer(timer);
    timers.push(timer);
  };
  schedule(params.intervals?.retentionMs ?? RETENTION_INTERVAL_MS, () => {
    retaining ??= runRetentionOnce().finally(() => {
      retaining = undefined;
    });
  });
  schedule(params.intervals?.resetCheckMs ?? RESET_CHECK_INTERVAL_MS, () => {
    void checkReset().catch(() => undefined);
  });
  if (params.surfaceFor !== undefined) {
    const surfaceFor = params.surfaceFor;
    let sweepingIntents = false;
    schedule(params.intervals?.intentSweepMs ?? RECOVERABLE_INTENT_SWEEP_INTERVAL_MS, () => {
      if (sweepingIntents || shutdownRequested || resetting) return;
      sweepingIntents = true;
      void sweepRecoverableIntents(db, { surfaceFor, now: now() })
        .catch((error: unknown) => {
          logWarn("periodic_intent_sweep_failed", { message: errorMessage(error) });
        })
        .finally(() => {
          sweepingIntents = false;
        });
    });
  }
  void checkReset().catch(() => undefined);

  const afterIntakeCommit = (conversationsToAbort: readonly string[]) => {
    dispatcher.notify();
    if (conversationsToAbort.length === 0 || resetting || harnessClosed) return;
    const harness = runtime.handle.harness;
    for (const text of conversationsToAbort) {
      const conversationId = conversationIdFromText(text);
      if (conversationId === undefined) continue;
      void harness
        .conversation(conversationId, context)
        .then((conversation) => conversation?.abort(context))
        .catch((error: unknown) => {
          logWarn("intake_conversation_abort_failed", {
            conversationId: text,
            message: errorMessage(error),
          });
        });
    }
  };

  const shutdown = (reason: string, exitCode = 0) => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownRequested = true;
    shutdownPromise = (async () => {
      logInfo("shutdown_requested", { reason });
      for (const timer of timers) clearInterval(timer);
      await resetChain;
      await retaining;
      dispatcher.pause();
      const drained = await dispatcher.drain(cfg.runtime.shutdownGraceMs);
      if (!drained) logWarn("shutdown_grace_elapsed", { graceMs: cfg.runtime.shutdownGraceMs });
      const closing = runtime;
      expectedClose.add(closing);
      try {
        await closing.handle.harness.close(context);
      } catch (error) {
        logWarn("pi_durable_close_failed", { message: errorMessage(error) });
      }
      await handlers.review.close();
      params.appState.close();
      for (const resolve of exitResolvers) resolve(exitCode);
    })();
    return shutdownPromise;
  };

  watchClosed(runtime);
  const ready = () => {
    if (harnessClosed || shutdownRequested) return false;
    try {
      db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  };

  return ((pinnedReturn: DurableService) => pinnedReturn)({
    deps,
    dispatcher,
    phaseA,
    acceptingWebhooks: () => !shutdownRequested,
    ready,
    afterIntakeCommit,
    checkReset,
    shutdown,
    exited,
  });
}
