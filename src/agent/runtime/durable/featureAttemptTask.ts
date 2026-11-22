import { defineTask } from "@earendil-works/pi-durable";
import * as v from "valibot";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Task, TaskId } from "@earendil-works/pi-durable";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../../../settings/index.ts";
import {
  attemptFor,
  isFeatureWorkKind,
  laneEpochCurrent,
  markAttemptRunning,
  markWorkRunCompleted,
  markWorkRunFailed,
  nextRetryAtMs,
  scheduleWorkRunRetry,
  workRunById,
  type ClaimedWorkRun,
  type WorkRunAttemptRow,
  type FeatureWorkKind,
  type WorkRunRow,
} from "../../../state/workRuns.ts";
import { immediate } from "../../../state/db.ts";
import { PR_SERIALIZED_KINDS, withPrMutex } from "../../../state/prMutex.ts";
import { maxAttempts, retryDispositionFor } from "../../../agentWork/retryPolicy.ts";
import { errorMessage } from "../../../errors/errorMessage.ts";

export const FEATURE_ATTEMPT_TASK_NAME = "pr.feature_attempt";

export const attemptStampSchema = v.object({
  workId: v.string(),
  attemptNo: v.number(),
  attemptId: v.string(),
});
export type AttemptStamp = v.InferOutput<typeof attemptStampSchema>;

type FeatureAttemptState = { readonly phase: "run" };

export type FeatureAttemptExecutor = (ctx: {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly run: WorkRunRow;
  readonly attempt: WorkRunAttemptRow;
  readonly signal: AbortSignal;
  readonly taskId: string;
  readonly conversationId: string;
  readonly context: Context;
}) => Promise<void>;

export type FeatureAttemptExecutorFor = (kind: FeatureWorkKind) => FeatureAttemptExecutor;

export type FeatureAttemptOutcome =
  | { readonly status: "completed" }
  | { readonly status: "cancelled"; readonly reason: string }
  | {
      readonly status: "failed";
      readonly error: { readonly message: string; readonly interrupted: boolean };
    };

type BoundRuntime = {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly executorFor: FeatureAttemptExecutorFor;
  readonly now?: () => number;
};

export function recordAttemptFailure(
  db: DatabaseSync,
  cfg: Pick<Config, "queue">,
  params: {
    readonly workId: string;
    readonly attemptNo: number;
    readonly error: unknown;
    readonly interrupted: boolean;
    readonly now: number;
  },
) {
  const disposition = params.interrupted ? "transient" : retryDispositionFor(params.error);
  const budgetRemains = params.attemptNo < maxAttempts(cfg);
  const mayRetry =
    disposition === "transient"
      ? budgetRemains
      : disposition === "deterministic" && params.attemptNo === 1 && budgetRemains;
  const errorJson = JSON.stringify({
    message: errorMessage(params.error),
    interrupted: params.interrupted,
    disposition,
  });
  return ((pinnedReturn: "retry_scheduled" | "failed") => pinnedReturn)(
    immediate(db, () => {
      if (mayRetry) {
        scheduleWorkRunRetry(db, {
          workId: params.workId,
          attemptNo: params.attemptNo,
          errorJson,
          nextRetryAt: nextRetryAtMs(params.attemptNo, cfg.queue, params.now),
          now: params.now,
        });
        return "retry_scheduled" as const;
      }
      markWorkRunFailed(db, {
        workId: params.workId,
        attemptNo: params.attemptNo,
        errorJson,
        now: params.now,
      });
      return "failed" as const;
    }),
  );
}

const ADMISSION_POLL_MS = 5;
const ADMISSION_TIMEOUT_MS = 10_000;

export async function awaitAttemptAdmission(
  db: DatabaseSync,
  stamp: AttemptStamp,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? ADMISSION_TIMEOUT_MS);
  for (;;) {
    const status = attemptFor(db, stamp.workId, stamp.attemptNo)?.status;
    if (status === "running") return ((pinnedReturn: boolean) => pinnedReturn)(true);
    if (status !== "starting" || options.signal?.aborted === true || Date.now() > deadline)
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
    await new Promise((resolve) => setTimeout(resolve, ADMISSION_POLL_MS));
  }
}

function attemptIsCurrent(
  db: DatabaseSync,
  run: WorkRunRow | undefined,
  attempt: WorkRunAttemptRow | undefined,
) {
  return (
    run !== undefined &&
    attempt !== undefined &&
    run.status === "running" &&
    run.cancel_reason === null &&
    run.current_attempt_no === attempt.attempt_no &&
    attempt.status === "running" &&
    laneEpochCurrent(db, run)
  );
}

async function executeAttempt(
  deps: BoundRuntime,
  input: AttemptStamp,
  invocation: {
    readonly signal: AbortSignal;
    readonly taskId: string;
    readonly conversationId: string;
    readonly context: Context;
  },
) {
  const now = deps.now ?? Date.now;
  await awaitAttemptAdmission(deps.db, input, { signal: invocation.signal });
  const run = workRunById(deps.db, input.workId);
  const attempt = attemptFor(deps.db, input.workId, input.attemptNo);
  if (run === undefined || attempt === undefined || !attemptIsCurrent(deps.db, run, attempt)) {
    return ((pinnedReturn: FeatureAttemptOutcome) => pinnedReturn)({
      status: "cancelled",
      reason: "work_run_no_longer_current",
    });
  }
  if (!isFeatureWorkKind(run.kind)) {
    recordAttemptFailure(deps.db, deps.cfg, {
      workId: run.work_id,
      attemptNo: attempt.attempt_no,
      error: new Error(`work kind ${run.kind} is not a feature attempt`),
      interrupted: false,
      now: now(),
    });
    return ((pinnedReturn: FeatureAttemptOutcome) => pinnedReturn)({
      status: "failed",
      error: { message: `work kind ${run.kind} is not a feature attempt`, interrupted: false },
    });
  }
  const executor = deps.executorFor(run.kind);
  const body = () => {
    const current = workRunById(deps.db, input.workId);
    const currentAttempt = attemptFor(deps.db, input.workId, input.attemptNo);
    if (!attemptIsCurrent(deps.db, current, currentAttempt))
      return ((pinnedReturn: Promise<boolean>) => pinnedReturn)(Promise.resolve(false));
    return ((pinnedReturn: Promise<boolean>) => pinnedReturn)(
      executor({ db: deps.db, cfg: deps.cfg, run, attempt, ...invocation }).then(() => true),
    );
  };
  let executed: boolean;
  try {
    executed = PR_SERIALIZED_KINDS.has(run.kind)
      ? await withPrMutex(run.pr_key, body)
      : await body();
  } catch (error) {
    recordAttemptFailure(deps.db, deps.cfg, {
      workId: run.work_id,
      attemptNo: attempt.attempt_no,
      error,
      interrupted: false,
      now: now(),
    });
    return ((pinnedReturn: FeatureAttemptOutcome) => pinnedReturn)({
      status: "failed",
      error: { message: errorMessage(error), interrupted: false },
    });
  }
  if (!executed) {
    return ((pinnedReturn: FeatureAttemptOutcome) => pinnedReturn)({
      status: "cancelled",
      reason: "work_run_no_longer_current",
    });
  }
  immediate(deps.db, () =>
    markWorkRunCompleted(deps.db, {
      workId: run.work_id,
      attemptNo: attempt.attempt_no,
      now: now(),
    }),
  );
  return ((pinnedReturn: FeatureAttemptOutcome) => pinnedReturn)({ status: "completed" });
}

export function createFeatureAttemptTask(deps: BoundRuntime) {
  return defineTask<AttemptStamp, FeatureAttemptState, FeatureAttemptOutcome>({
    name: FEATURE_ATTEMPT_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, ctx) => {
        const outcome = await executeAttempt(deps, task.input, {
          signal: runtime.signal,
          taskId: String(runtime.taskId),
          conversationId: String(runtime.conversationId),
          context: ctx,
        });
        await runtime.commit(
          () => ({
            status: "terminal" as const,
            outcome:
              outcome.status === "completed"
                ? ({ status: "completed", result: outcome } as const)
                : ({
                    status: "failed",
                    error: {
                      message:
                        outcome.status === "cancelled"
                          ? `cancelled: ${outcome.reason}`
                          : outcome.error.message,
                    },
                  } as const),
          }),
          ctx,
        );
      },
    },
    abort: async (task, runtime, ctx) => {
      const run = workRunById(deps.db, task.input.workId);
      const attempt = attemptFor(deps.db, task.input.workId, task.input.attemptNo);
      if (attemptIsCurrent(deps.db, run, attempt)) {
        recordAttemptFailure(deps.db, deps.cfg, {
          workId: task.input.workId,
          attemptNo: task.input.attemptNo,
          error: new Error("feature attempt aborted"),
          interrupted: true,
          now: (deps.now ?? Date.now)(),
        });
      }
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: {
            status: "aborted" as const,
            reason: `${task.input.workId}#${task.input.attemptNo}`,
          },
        }),
        ctx,
      );
    },
  });
}

export async function startAttemptTask<
  I extends AttemptStamp,
  S extends { phase: string },
  R,
>(params: {
  readonly harness: Harness;
  readonly context: Context;
  readonly db: DatabaseSync;
  readonly claim: ClaimedWorkRun;
  readonly task: Task<I, S, R, object>;
  readonly input: I;
  readonly now?: number;
}) {
  const created = await params.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const taskId = await tx.createTask(params.task, params.input, {
      ownership: { kind: "conversation" },
      conversationId: conversation.id,
    });
    return ((pinnedReturn: { conversationId: ConversationId; taskId: TaskId }) => pinnedReturn)({
      conversationId: conversation.id,
      taskId,
    });
  }, params.context);
  const marked = immediate(params.db, () =>
    markAttemptRunning(params.db, {
      workId: params.claim.run.work_id,
      attemptNo: params.claim.attempt.attempt_no,
      conversationId: String(created.conversationId),
      taskId: String(created.taskId),
      now: params.now ?? Date.now(),
    }),
  );
  if (marked === 0) {
    const conversation = await params.harness.conversation(created.conversationId, params.context);
    await conversation?.abort(params.context);
  }
  return {
    markedRunning: marked !== 0,
    conversationId: String(created.conversationId),
    taskId: created.taskId,
  };
}

export function startClaimedAttempt<S extends { phase: string }, R>(
  task: Task<AttemptStamp, S, R, object>,
  params: {
    readonly harness: Harness;
    readonly context: Context;
    readonly db: DatabaseSync;
    readonly claim: ClaimedWorkRun;
    readonly now?: number;
  },
) {
  return startAttemptTask({
    ...params,
    task,
    input: {
      workId: params.claim.run.work_id,
      attemptNo: params.claim.attempt.attempt_no,
      attemptId: params.claim.attempt.attempt_id,
    },
  });
}
