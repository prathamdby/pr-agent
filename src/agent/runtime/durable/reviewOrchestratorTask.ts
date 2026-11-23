import {
  configure,
  SubmissionSettled,
  type SubmissionRecord,
  type TaskId,
  defineTask,
  type ConversationId,
  type NextTaskState,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  REVIEW_FINALIZATION_WINDOW_MS,
  REVIEW_INTAKE_CHECKOUT_BUDGET_MS,
  REVIEW_RECON_BUDGET_MS,
} from "../../../settings/index.ts";
import { immediate } from "../../../state/db.ts";
import {
  attemptFor,
  cancelLiveAttempt,
  markWorkRunCompleted,
  supersedeWorkRun,
  cancelWorkRun,
  workRunById,
} from "../../../state/workRuns.ts";
import {
  initReviewRunMetrics,
  logReviewRunCompleted,
  releaseReviewRunMetrics,
} from "../../../review/run/reviewRunMetrics.ts";
import { escalationForAttempt } from "../../../agentWork/retryPolicy.ts";
import { errorMessage } from "../../../errors/errorMessage.ts";
import { logWarn, runWithOperationLogger } from "../../../evlog.ts";
import { openReviewAttemptEnv } from "../../../review/runReviewForWorkItem.ts";
import {
  conversationIdFor,
  initialReviewCheckpoint,
  openReviewAttemptLive,
  REVIEW_CONVERSATION_ROLES,
  reviewChildRequest,
  reviewWorkIsCurrent,
  runReviewPhase,
  withConversationId,
  type ReviewAttemptCheckpoint,
  type ReviewAttemptLive,
  type ReviewAttemptResult,
  type ReviewConversationRole,
  type ReviewPhaseStep,
  type ReviewTurnReader,
} from "../../../review/orchestrator/orchestratorRun.ts";
import { SPECIALIST_IDS } from "../../../review/orchestrator/orchestratorTypes.ts";
import { resolveThinkingLevel, thinkingPolicyFromCeiling } from "../thinkingPolicy.ts";
import type { AgentSessionPhase } from "../types.ts";
import * as v from "valibot";
import { isRecord } from "../../../util/typeGuards.ts";
import { conversationIdFromText } from "./harness.ts";
import {
  attemptStampSchema,
  awaitAttemptAdmission,
  recordAttemptFailure,
  type AttemptStamp,
} from "./featureAttemptTask.ts";
import {
  abortReviewChild,
  bindReviewChild,
  initReviewChild,
  installReviewChild,
  releaseReviewChild,
  reviewExtensionName,
  settledTurnKey,
  settledTurnSignalKey,
  type ReviewChildLive,
} from "./reviewConversations.ts";
import { creditVisibleReads } from "./evidenceMemo.ts";
import {
  beginSend,
  maxTurnsForSend,
  WarmupReleased,
  warmupReleaseKey,
  warmupReleaseSignalKey,
} from "./sessionState.ts";
import { journalReviewTurn, reviewOutputStore } from "./reviewTurnJournal.ts";
import type { WorkerDeps } from "./workerDeps.ts";

type ReviewTaskState = { readonly phase: "start" } | ReviewAttemptCheckpoint;

type ReviewTaskResult = {
  readonly status: "completed" | "cancelled";
  readonly detail: string;
};

export type LiveAttempt = {
  readonly live: ReviewAttemptLive;
  readonly controller: AbortController;
  readonly children: Map<ReviewConversationRole, ReviewChildLive & { id: ConversationId }>;
};

type ReviewRuntime = TaskRuntime<AttemptStamp, ReviewTaskState, ReviewTaskResult, object>;

function isReviewCheckpoint(state: unknown): state is ReviewAttemptCheckpoint {
  return (
    isRecord(state) &&
    typeof state.headSha === "string" &&
    (state.baseSha === null || typeof state.baseSha === "string") &&
    isRecord(state.orchestrator) &&
    isRecord(state.specialists) &&
    isRecord(state.timing) &&
    (state.phase === "recon" ||
      state.phase === "dispatch_specialists" ||
      state.phase === "wait_specialists" ||
      state.phase === "synthesize_and_validate" ||
      state.phase === "publish")
  );
}

function thinkingFor(deps: WorkerDeps, phase: AgentSessionPhase) {
  return resolveThinkingLevel({
    policy: thinkingPolicyFromCeiling(deps.cfg.models.thinkingCeiling),
    phase,
  });
}

async function openChild(
  deps: WorkerDeps,
  attempt: LiveAttempt,
  checkpoint: ReviewAttemptCheckpoint,
  attemptId: string,
  role: ReviewConversationRole,
  acquire: (
    spec: ReturnType<typeof reviewChildRequest>,
    child: ReviewChildLive,
  ) => Promise<ConversationId>,
) {
  const spec = reviewChildRequest(attempt.live, checkpoint, role);
  const child = installReviewChild(deps.runtime, {
    ...spec,
    extensionName: reviewExtensionName(attemptId, role),
  });
  let id: ConversationId | undefined;
  try {
    id = await acquire(spec, child);
    const ledger =
      role === "orchestrator"
        ? attempt.live.setup.evidenceLedger
        : attempt.live.setup.specialistLedgers[role];
    await bindReviewChild(
      deps.runtime,
      id,
      child,
      (reads) => creditVisibleReads(reads, ledger),
      spec.systemPromptSharedHead,
    );
    attempt.children.set(role, { ...child, id });
  } catch (error) {
    releaseReviewChild(deps.runtime, id, child);
    throw error;
  }
}

function armWarmupRelease(
  taskId: TaskId,
  checkpoint: ReviewAttemptCheckpoint,
  attempt: LiveAttempt,
) {
  const lead = SPECIALIST_IDS[0];
  const track = checkpoint.specialists[lead];
  if (
    checkpoint.warmup.released ||
    track.warmupReleasePending !== true ||
    track.turnNo === 0 ||
    (track.stage !== "investigating" && track.stage !== "wrap_up" && track.stage !== "repair")
  )
    return;
  const child = attempt.children.get(lead);
  if (child === undefined) return;
  child.state.warmupRelease = {
    taskId,
    key: warmupReleaseKey(track.turnNo - 1),
    sent: false,
  };
}

async function disposeLive(deps: WorkerDeps, attempt: LiveAttempt) {
  attempt.controller.abort();
  for (const child of attempt.children.values()) releaseReviewChild(deps.runtime, child.id, child);
  await attempt.live.dispose();
}

async function openAttempt(
  deps: WorkerDeps,
  input: AttemptStamp,
  taskId: TaskId,
  checkpoint?: ReviewAttemptCheckpoint,
) {
  const run = workRunById(deps.db, input.workId);
  if (!run) throw new Error(`review work run ${input.workId} is missing`);
  const store = await reviewOutputStore(deps.runtime.handle.harness, taskId);
  const controller = new AbortController();
  const env = await openReviewAttemptEnv({
    cfg: deps.cfg,
    db: deps.db,
    installationSurface: deps.installationSurface,
    shutdownRequested: deps.shutdownRequested,
    signal: controller.signal,
    work: {
      workId: run.work_id,
      prKey: run.pr_key,
      laneEpoch: run.lane_epoch,
      payloadJson: run.payload_json,
    },
    revision: checkpoint,
  });
  const escalation = escalationForAttempt(input.attemptNo, deps.cfg);
  const live = await openReviewAttemptLive({ env, checkpoint, escalation, ...store }).catch(
    async (error: unknown) => {
      await env.dispose();
      throw error;
    },
  );
  const attempt: LiveAttempt = { live, controller, children: new Map() };
  try {
    if (checkpoint) {
      for (const role of REVIEW_CONVERSATION_ROLES) {
        const stored = conversationIdFor(checkpoint, role);
        if (stored === undefined) continue;
        const id = conversationIdFromText(stored);
        if (id === undefined) throw new Error(`invalid ${role} conversation ID`);
        await openChild(deps, attempt, checkpoint, input.attemptId, role, async (spec) => {
          const conversation = await deps.runtime.handle.harness.conversation(
            id,
            BACKGROUND_CONTEXT,
          );
          if (!conversation) throw new Error(`missing ${role} conversation`);
          await conversation.configure({ cwd: spec.cwd }, BACKGROUND_CONTEXT);
          return id;
        });
      }
      armWarmupRelease(taskId, checkpoint, attempt);
    }
    return attempt;
  } catch (error) {
    await disposeLive(deps, attempt);
    throw error;
  }
}

export function turnReader(
  runtime: ReviewRuntime,
  context: Context,
  attemptId: string,
  conversationIdForRole: (role: ReviewConversationRole) => ConversationId | undefined,
) {
  const requestSettled = async (role: ReviewConversationRole, turnNo: number) => {
    const conversationId = conversationIdForRole(role);
    if (conversationId === undefined) return undefined;
    const requestId = `${attemptId}:${role}:${turnNo}`;
    let record: SubmissionRecord | undefined;
    await runtime.commit(async (tx) => {
      record = await tx.submissionByRequest(conversationId, requestId);
      return undefined;
    }, context);
    return record;
  };
  const reader: ReviewTurnReader = {
    now: () => runtime.now(),
    settled: async (role, turnNo) => {
      const signal = await runtime.readSignal(
        SubmissionSettled,
        settledTurnKey(role, turnNo),
        context,
      );
      if (signal !== undefined && "expired" in signal) {
        const record = await requestSettled(role, turnNo);
        if (record === undefined) return { status: "observing" };
        if (record.status === "done") return { status: "done" };
        if (record.status === "unanswered") return { status: "unanswered", reason: record.reason };
        return { status: "observing" };
      }
      if (!signal || !("value" in signal)) return { status: "pending" };
      return signal.value.status === "unanswered"
        ? { status: "unanswered", reason: signal.value.reason }
        : { status: "done" };
    },
    warmupReleased: async (turnNo) => {
      const signal = await runtime.readSignal(WarmupReleased, warmupReleaseKey(turnNo), context);
      return signal !== undefined && "value" in signal;
    },
  };
  return reader;
}

function writeTerminalOutcome(deps: WorkerDeps, input: AttemptStamp, result: ReviewAttemptResult) {
  const now = deps.now?.() ?? Date.now();
  immediate(deps.db, () => {
    const run = workRunById(deps.db, input.workId);
    if (run?.status !== "running" || run.current_attempt_no !== input.attemptNo) {
      cancelLiveAttempt(deps.db, { ...input, now });
    } else if (result.status === "completed") {
      markWorkRunCompleted(deps.db, { ...input, now });
    } else if (result.reason === "superseded" || result.reason === "stale_head") {
      supersedeWorkRun(deps.db, { ...input, now });
    } else {
      cancelWorkRun(deps.db, { ...input, now, reason: result.reason });
    }
  });
}

export async function executeStep(
  deps: WorkerDeps,
  runtime: ReviewRuntime,
  context: Context,
  input: AttemptStamp,
  attempt: LiveAttempt,
  step: ReviewPhaseStep,
) {
  const commitState = (state: NextTaskState<ReviewTaskState, ReviewTaskResult>) =>
    runtime.commit(() => state, context);
  switch (step.kind) {
    case "advance":
      await commitState({ status: "running", checkpoint: step.checkpoint });
      return;
    case "create_child": {
      await openChild(
        deps,
        attempt,
        step.checkpoint,
        input.attemptId,
        step.role,
        async (spec, child) => {
          let id: ConversationId | undefined;
          await runtime.commit(async (tx) => {
            id = await initReviewChild(
              tx,
              runtime.taskId,
              deps.runtime.codemodeExtension,
              spec,
              child,
              thinkingFor(deps, step.role === "orchestrator" ? "recon" : "specialist"),
            );
            return {
              status: "running",
              checkpoint: withConversationId(step.checkpoint, step.role, String(id)),
            };
          }, context);
          if (id === undefined) throw new Error("review child creation did not commit");
          return id;
        },
      );
      return;
    }
    case "submit": {
      attempt.live.bindCheckpoint(step.checkpoint);
      const role = step.turn.role;
      const child = attempt.children.get(role);
      if (!child) throw new Error(`review ${role} conversation is missing`);
      const conversation = await runtime.conversation(child.id, context);
      if (!conversation) throw new Error(`missing ${role} conversation`);
      const { opts, turnNo, prompt } = step.turn;
      child.state.currentSend = beginSend(opts);
      armWarmupRelease(runtime.taskId, step.checkpoint, attempt);
      await runtime.commit(async (tx) => {
        await configure(tx, child.id, {
          maxTurns: maxTurnsForSend(opts),
          thinkingLevel: thinkingFor(deps, opts.phase),
        });
        await journalReviewTurn(tx, child.id, opts);
        await conversation.submit(tx, {
          type: "input",
          content: prompt,
          requestId: `${input.attemptId}:${role}:${turnNo}`,
          notify: { taskId: runtime.taskId, key: settledTurnKey(role, turnNo) },
        });
        return { status: "running", checkpoint: step.checkpoint };
      }, context);
      return;
    }
    case "park": {
      const signals = [
        ...step.waitFor.map((wait) => settledTurnSignalKey(wait.role, wait.turnNo)),
        ...(step.waitWarmup ?? []).map((turnNo) => warmupReleaseSignalKey(turnNo)),
      ];
      await commitState({
        status: "sleeping",
        checkpoint: step.checkpoint,
        ...(signals.length > 0 ? { signals } : {}),
        ...(step.until !== undefined || signals.length === 0
          ? { until: step.until ?? runtime.now() }
          : {}),
      });
      return;
    }
    case "abort_children": {
      for (const role of step.roles) {
        const id = attempt.children.get(role)?.id;
        if (id !== undefined) await abortReviewChild(runtime, context, id);
      }
      await commitState({ status: "running", checkpoint: step.checkpoint });
      return;
    }
    case "finish": {
      writeTerminalOutcome(deps, input, step.result);
      await commitState({
        status: "terminal",
        outcome: {
          status: "completed",
          result: {
            status: step.result.status,
            detail:
              step.result.status === "completed"
                ? step.result.published
                  ? "published"
                  : "not_published"
                : step.result.reason,
          },
        },
      });
      return;
    }
    default: {
      const exhaustive: never = step;
      throw new Error(`unknown review step ${String(exhaustive)}`);
    }
  }
}

export function createReviewRunner(deps: WorkerDeps) {
  const attempts = new Map<string, LiveAttempt>();
  const close = async (attemptId: string) => {
    releaseReviewRunMetrics(attemptId);
    const attempt = attempts.get(attemptId);
    if (!attempt) return;
    attempts.delete(attemptId);
    await disposeLive(deps, attempt);
  };
  const prepare = async (
    input: AttemptStamp,
    taskId: TaskId,
    checkpoint?: ReviewAttemptCheckpoint,
  ) => {
    const attempt = await openAttempt(deps, input, taskId, checkpoint);
    attempts.set(input.attemptId, attempt);
    return attempt;
  };
  const runPhase = async (
    task: { input: AttemptStamp; state: { checkpoint: ReviewTaskState } },
    runtime: ReviewRuntime,
    context: Context,
  ) => {
    const { input } = task;
    await runWithOperationLogger(
      {
        method: "TASK",
        path: "pr.review_orchestrator",
        requestId: input.attemptId,
        context: {
          workId: input.workId,
          attemptNo: input.attemptNo,
          phase: task.state.checkpoint.phase,
        },
      },
      async () => {
        try {
          const stored =
            task.state.checkpoint.phase === "start" ? undefined : task.state.checkpoint;
          if (!stored) await awaitAttemptAdmission(deps.db, input, { signal: runtime.signal });
          if (
            !attempts.has(input.attemptId) &&
            (!reviewWorkIsCurrent(deps.db, input.workId) ||
              workRunById(deps.db, input.workId)?.current_attempt_no !== input.attemptNo)
          ) {
            writeTerminalOutcome(deps, input, { status: "cancelled", reason: "superseded" });
            await close(input.attemptId);
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: { status: "cancelled", detail: "work_run_no_longer_current" },
                },
              }),
              context,
            );
            return;
          }
          const attempt =
            attempts.get(input.attemptId) ?? (await prepare(input, runtime.taskId, stored));
          const attemptRow = attemptFor(deps.db, input.workId, input.attemptNo);
          initReviewRunMetrics({
            provider: deps.cfg.models.provider,
            model: deps.cfg.models.model,
            mode: attempt.live.env.item.reviewLens,
            runKey: input.attemptId,
            ...(attemptRow?.started_at != null ? { startedAtMs: attemptRow.started_at } : {}),
          });
          const checkpoint =
            stored ??
            initialReviewCheckpoint({
              now: runtime.now(),
              headSha: attempt.live.env.headSha,
              baseSha: attempt.live.env.baseSha,
              budgetMs: REVIEW_ATTEMPT_BUDGET_MS,
              finalizationMs: REVIEW_FINALIZATION_WINDOW_MS,
              reconBudgetMs: REVIEW_INTAKE_CHECKOUT_BUDGET_MS + REVIEW_RECON_BUDGET_MS,
            });
          const step = await runReviewPhase(
            attempt.live,
            checkpoint,
            turnReader(runtime, context, input.attemptId, (role) => attempt.children.get(role)?.id),
          );
          await executeStep(deps, runtime, context, input, attempt, step);
          if (step.kind === "finish") {
            logReviewRunCompleted({
              workId: input.workId,
              attemptNo: input.attemptNo,
              status: step.result.status,
              ...(step.result.status === "cancelled" ? { reason: step.result.reason } : {}),
            });
            await close(input.attemptId);
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          logWarn("review_orchestrator_phase_failed", {
            workId: input.workId,
            attemptNo: input.attemptNo,
            message: errorMessage(error),
          });
          recordAttemptFailure(deps.db, deps.cfg, {
            ...input,
            error,
            interrupted: false,
            now: deps.now?.() ?? Date.now(),
          });
          await close(input.attemptId);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "failed", error: { message: errorMessage(error) } },
            }),
            context,
          );
        }
      },
    );
  };
  const task = defineTask<AttemptStamp, ReviewTaskState, ReviewTaskResult>({
    name: "pr.review_orchestrator",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: runPhase,
      recon: runPhase,
      dispatch_specialists: runPhase,
      wait_specialists: runPhase,
      synthesize_and_validate: runPhase,
      publish: runPhase,
    },
    abort: async ({ input }, runtime, ctx) => {
      writeTerminalOutcome(deps, input, { status: "cancelled", reason: "aborted" });
      await close(input.attemptId);
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: `${input.workId}#${input.attemptNo}` },
        }),
        ctx,
      );
    },
  });
  return {
    task,
    restore: async (taskId: TaskId, context: Context) => {
      const record = await deps.runtime.handle.harness.getTask(taskId, context);
      if (!record || record.kind !== task.definition.name)
        throw new Error("missing durable review task");
      if (record.state.status === "terminal" || record.state.status === "completing") return true;
      const input = v.parse(attemptStampSchema, record.input);
      const checkpoint = record.state.checkpoint;
      if (isRecord(checkpoint) && checkpoint.phase === "start") return true;
      try {
        if (!isReviewCheckpoint(checkpoint)) throw new Error("invalid durable review checkpoint");
        await prepare(input, taskId, checkpoint);
        return true;
      } catch (error) {
        logWarn("review_restore_failed", {
          workId: input.workId,
          attemptNo: input.attemptNo,
          message: errorMessage(error),
        });
        recordAttemptFailure(deps.db, deps.cfg, {
          ...input,
          error,
          interrupted: false,
          now: deps.now?.() ?? Date.now(),
        });
        return false;
      }
    },
    close: async () => {
      for (const id of attempts.keys()) await close(id);
    },
  };
}
