import {
  defineExtension,
  defineTask,
  type ConversationId,
  type NextTaskState,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { DatabaseSync } from "node:sqlite";
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  REVIEW_FINALIZATION_WINDOW_MS,
  REVIEW_INTAKE_CHECKOUT_BUDGET_MS,
  REVIEW_RECON_BUDGET_MS,
} from "../../../settings/index.ts";
import { immediate } from "../../../state/db.ts";
import {
  cancelLiveAttempt,
  markWorkRunCompleted,
  markWorkRunFailed,
  nextRetryAtMs,
  scheduleWorkRunRetry,
  workRunById,
  type ClaimedWorkRun,
} from "../../../state/workRuns.ts";
import { escalationForAttempt, maxAttempts } from "../../../agentWork/retryPolicy.ts";
import { errorMessage } from "../../../errors/errorMessage.ts";
import { logWarn } from "../../../evlog.ts";
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
import { resolveThinkingLevel, thinkingPolicyFromCeiling } from "../thinkingPolicy.ts";
import type { AgentSessionPhase } from "../types.ts";
import type { ReviewAttemptHandler } from "./dispatcher.ts";
import { awaitAttemptAdmission, startAttemptTask } from "./featureAttemptTask.ts";
import {
  abortReviewChild,
  bindReviewChild,
  creditBindings,
  initReviewChild,
  installReviewChild,
  readEvidenceBindings,
  reviewChildConversations,
  readSettledTurn,
  releaseReviewChild,
  reviewExtensionName,
  settledTurnKey,
  settledTurnSignalKey,
  submitReviewTurn,
  transcriptToolCalls,
  type ReviewChildLive,
  type ReviewChildSpec,
} from "./reviewConversations.ts";
import type { WorkerDeps } from "./workerDeps.ts";

export type ReviewOrchestratorInput = {
  readonly workId: string;
  readonly attemptNo: number;
  readonly attemptId: string;
  readonly prKey: string;
};

type ReviewTaskState = { readonly phase: string; readonly review?: string };

type ReviewTaskResult = {
  readonly status: "completed" | "cancelled" | "failed";
  readonly detail: string;
};

type LiveAttempt = {
  readonly live: ReviewAttemptLive;
  readonly children: Map<ReviewConversationRole, ReviewChildLive>;
  readonly ids: Map<string, ConversationId>;
};

const liveAttempts = new Map<string, Promise<LiveAttempt>>();
let boundDeps: WorkerDeps | undefined;

type ReviewRuntime = TaskRuntime<
  ReviewOrchestratorInput,
  ReviewTaskState,
  ReviewTaskResult,
  object
>;

function decodeCheckpoint(state: ReviewTaskState) {
  if (state.review === undefined)
    return ((pinnedReturn: ReviewAttemptCheckpoint | undefined) => pinnedReturn)(undefined);
  const parsed: unknown = JSON.parse(state.review);
  return ((pinnedReturn: ReviewAttemptCheckpoint | undefined) => pinnedReturn)(
    typeof parsed === "object" && parsed !== null && "phase" in parsed
      ? (parsed as ReviewAttemptCheckpoint)
      : undefined,
  );
}

function encodeCheckpoint(checkpoint: ReviewAttemptCheckpoint) {
  return ((pinnedReturn: ReviewTaskState) => pinnedReturn)({
    phase: checkpoint.phase,
    review: JSON.stringify(checkpoint),
  });
}

function phaseForRole(role: ReviewConversationRole) {
  return ((pinnedReturn: AgentSessionPhase) => pinnedReturn)(
    role === "orchestrator" ? "recon" : "specialist",
  );
}

function thinkingFor(deps: WorkerDeps, phase: AgentSessionPhase) {
  return resolveThinkingLevel({
    policy: thinkingPolicyFromCeiling(deps.cfg.models.thinkingCeiling),
    phase,
  });
}

function childSpec(
  attempt: LiveAttempt,
  checkpoint: ReviewAttemptCheckpoint,
  attemptId: string,
  role: ReviewConversationRole,
) {
  const request = reviewChildRequest(attempt.live, checkpoint, role);
  return ((pinnedReturn: ReviewChildSpec) => pinnedReturn)({
    ...request,
    extensionName: reviewExtensionName(attemptId, role),
    codemode: true,
  });
}

function installChild(
  deps: WorkerDeps,
  attempt: LiveAttempt,
  checkpoint: ReviewAttemptCheckpoint,
  attemptId: string,
  role: ReviewConversationRole,
) {
  const existing = attempt.children.get(role);
  if (existing !== undefined) return existing;
  const spec = childSpec(attempt, checkpoint, attemptId, role);
  const child = installReviewChild(deps.runtime, spec);
  attempt.children.set(role, child);
  if (role !== "orchestrator") {
    const ledger = attempt.live.setup.specialistLedgers[role];
    attempt.live.setEvidenceCreditor(role, () =>
      creditBindings(child.state.evidence.bindings, ledger),
    );
  }
  const conversationId = attempt.ids.get(role);
  if (conversationId !== undefined)
    bindReviewChild(deps.runtime, conversationId, child, spec.systemPromptSharedHead);
  return child;
}

async function ensureLive(
  deps: WorkerDeps,
  runtime: ReviewRuntime,
  context: Context,
  input: ReviewOrchestratorInput,
  checkpoint: ReviewAttemptCheckpoint | undefined,
  signal: AbortSignal,
) {
  const existing = liveAttempts.get(input.attemptId);
  if (existing !== undefined) return existing;
  const created = (async () => {
    const run = workRunById(deps.db, input.workId);
    if (run === undefined) throw new Error(`review work run ${input.workId} is missing`);
    const env = await openReviewAttemptEnv({
      cfg: deps.cfg,
      db: deps.db,
      installationSurface: deps.installationSurface,
      shutdownRequested: deps.shutdownRequested,
      signal,
      work: {
        workId: run.work_id,
        prKey: run.pr_key,
        laneEpoch: run.lane_epoch,
        payloadJson: run.payload_json,
      },
      ...(checkpoint !== undefined ? { boundHeadSha: checkpoint.headSha } : {}),
    });
    const escalation = escalationForAttempt(input.attemptNo, deps.cfg);
    const live = await openReviewAttemptLive({
      env,
      checkpoint,
      ...(escalation !== undefined ? { escalation } : {}),
    });
    const ids =
      checkpoint === undefined
        ? new Map<string, ConversationId>()
        : await reviewChildConversations(runtime, context);
    const attempt: LiveAttempt = { live, children: new Map(), ids };
    if (checkpoint !== undefined) {
      for (const role of REVIEW_CONVERSATION_ROLES) {
        if (ids.has(role)) installChild(deps, attempt, checkpoint, input.attemptId, role);
      }
    }
    return attempt;
  })();
  liveAttempts.set(input.attemptId, created);
  created.catch(() => liveAttempts.delete(input.attemptId));
  return created;
}

async function disposeLive(deps: WorkerDeps, input: ReviewOrchestratorInput) {
  const pending = liveAttempts.get(input.attemptId);
  liveAttempts.delete(input.attemptId);
  if (pending === undefined) return;
  const attempt = await pending.catch(() => undefined);
  if (attempt === undefined) return;
  for (const child of attempt.children.values()) releaseReviewChild(deps.runtime, undefined, child);
  await attempt.live.dispose().catch(() => undefined);
}

function turnReader(
  runtime: ReviewRuntime,
  context: Context,
  attempt: LiveAttempt,
  checkpoint: ReviewAttemptCheckpoint,
) {
  const conversationOf = (role: ReviewConversationRole) => {
    const id = attempt.ids.get(role);
    if (id === undefined || conversationIdFor(checkpoint, role) === undefined)
      throw new Error(`review ${role} conversation is missing`);
    return id;
  };
  return ((pinnedReturn: ReviewTurnReader) => pinnedReturn)({
    now: () => runtime.now(),
    settled: async (role, turnNo) => {
      const child = attempt.children.get(role);
      return readSettledTurn(runtime, context, {
        key: settledTurnKey(role, turnNo),
        conversationId: conversationOf(role),
        ...(child !== undefined ? { live: child } : {}),
      });
    },
    toolCalls: async (role, toolName) =>
      transcriptToolCalls(await runtime.context(conversationOf(role), context), toolName),
    creditEvidence: async (role, ledger, upto) => {
      const bindings = await readEvidenceBindings(runtime, context, conversationOf(role));
      creditBindings(bindings.slice(0, upto), ledger);
    },
  });
}

function failAttempt(deps: WorkerDeps, input: ReviewOrchestratorInput, error: unknown) {
  const now = deps.now?.() ?? Date.now();
  const errorJson = JSON.stringify({ message: errorMessage(error), interrupted: false });
  immediate(deps.db, () => {
    if (input.attemptNo < maxAttempts(deps.cfg)) {
      scheduleWorkRunRetry(deps.db, {
        workId: input.workId,
        attemptNo: input.attemptNo,
        errorJson,
        nextRetryAt: nextRetryAtMs(input.attemptNo, deps.cfg.queue, now),
        now,
      });
    } else {
      markWorkRunFailed(deps.db, {
        workId: input.workId,
        attemptNo: input.attemptNo,
        errorJson,
        now,
      });
    }
  });
}

function cancelAttemptRow(db: DatabaseSync, input: ReviewOrchestratorInput, now: number) {
  immediate(db, () => {
    cancelLiveAttempt(db, {
      workId: input.workId,
      attemptNo: input.attemptNo,
      now,
    });
  });
}

function writeTerminalOutcome(
  deps: WorkerDeps,
  input: ReviewOrchestratorInput,
  result: ReviewAttemptResult,
) {
  const now = deps.now?.() ?? Date.now();
  const run = workRunById(deps.db, input.workId);
  if (result.status === "completed" && run?.status === "running") {
    immediate(deps.db, () =>
      markWorkRunCompleted(deps.db, {
        workId: input.workId,
        attemptNo: input.attemptNo,
        now,
      }),
    );
    return;
  }
  if (run?.status === "running" && result.status === "cancelled") {
    immediate(deps.db, () =>
      markWorkRunCompleted(deps.db, {
        workId: input.workId,
        attemptNo: input.attemptNo,
        now,
      }),
    );
    return;
  }
  cancelAttemptRow(deps.db, input, now);
}

async function executeStep(
  deps: WorkerDeps,
  runtime: ReviewRuntime,
  context: Context,
  input: ReviewOrchestratorInput,
  attempt: LiveAttempt,
  step: ReviewPhaseStep,
) {
  const commitState = (state: NextTaskState<ReviewTaskState, ReviewTaskResult>) =>
    runtime.commit(() => state, context);
  switch (step.kind) {
    case "advance":
      await commitState({ status: "running", checkpoint: encodeCheckpoint(step.checkpoint) });
      return;
    case "create_child": {
      const child = installChild(deps, attempt, step.checkpoint, input.attemptId, step.role);
      const spec = childSpec(attempt, step.checkpoint, input.attemptId, step.role);
      let createdId: ConversationId | undefined;
      await runtime.commit(async (tx) => {
        const id = await initReviewChild(
          tx,
          runtime.taskId,
          step.role,
          spec,
          child,
          thinkingFor(deps, phaseForRole(step.role)),
        );
        createdId = id;
        return {
          status: "running" as const,
          checkpoint: encodeCheckpoint(withConversationId(step.checkpoint, step.role, String(id))),
        };
      }, context);
      if (createdId !== undefined) {
        attempt.ids.set(step.role, createdId);
        bindReviewChild(deps.runtime, createdId, child, spec.systemPromptSharedHead);
      }
      return;
    }
    case "submit": {
      const role = step.turn.role;
      const child = installChild(deps, attempt, step.checkpoint, input.attemptId, role);
      const conversationId = attempt.ids.get(role);
      if (conversationId === undefined) throw new Error(`review ${role} conversation is missing`);
      await submitReviewTurn(runtime, context, {
        conversationId,
        live: child,
        requestId: `${input.attemptId}:${role}:${step.turn.turnNo}`,
        key: settledTurnKey(role, step.turn.turnNo),
        prompt: step.turn.prompt,
        opts: step.turn.opts,
        thinkingLevel: thinkingFor(deps, step.turn.opts.phase),
      });
      await commitState({ status: "running", checkpoint: encodeCheckpoint(step.checkpoint) });
      return;
    }
    case "park":
      await commitState({
        status: "sleeping",
        checkpoint: encodeCheckpoint(step.checkpoint),
        ...(step.waitFor.length > 0
          ? {
              signals: step.waitFor.map((wait) => settledTurnSignalKey(wait.role, wait.turnNo)),
            }
          : {}),
        ...(step.until !== undefined || step.waitFor.length === 0
          ? { until: step.until ?? runtime.now() }
          : {}),
      });
      return;
    case "abort_children": {
      for (const role of step.roles) {
        const id = attempt.ids.get(role);
        if (id !== undefined) await abortReviewChild(runtime, context, id);
      }
      await commitState({ status: "running", checkpoint: encodeCheckpoint(step.checkpoint) });
      return;
    }
    case "finish": {
      writeTerminalOutcome(deps, input, step.result);
      await disposeLive(deps, input);
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

async function runReviewTaskPhase(
  task: {
    readonly input: ReviewOrchestratorInput;
    readonly state: { readonly checkpoint: ReviewTaskState };
  },
  runtime: ReviewRuntime,
  context: Context,
) {
  const deps = boundDeps;
  const input = task.input;
  if (deps === undefined) {
    await runtime.commit(
      () => ({
        status: "terminal" as const,
        outcome: {
          status: "failed" as const,
          error: { message: "review orchestrator runtime is not bound" },
        },
      }),
      context,
    );
    return;
  }
  const stored = decodeCheckpoint(task.state.checkpoint);
  if (stored === undefined) {
    await awaitAttemptAdmission(deps.db, input, { signal: runtime.signal });
    if (!reviewWorkIsCurrent(deps.db, input.workId)) {
      cancelAttemptRow(deps.db, input, deps.now?.() ?? Date.now());
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: {
            status: "completed" as const,
            result: { status: "cancelled" as const, detail: "work_run_no_longer_current" },
          },
        }),
        context,
      );
      return;
    }
  }
  try {
    const attempt = await ensureLive(deps, runtime, context, input, stored, runtime.signal);
    const checkpoint =
      stored ??
      initialReviewCheckpoint({
        now: runtime.now(),
        headSha: attempt.live.env.headSha,
        budgetMs: REVIEW_ATTEMPT_BUDGET_MS,
        finalizationMs: REVIEW_FINALIZATION_WINDOW_MS,
        reconBudgetMs: REVIEW_INTAKE_CHECKOUT_BUDGET_MS + REVIEW_RECON_BUDGET_MS,
      });
    const step = await runReviewPhase(
      attempt.live,
      checkpoint,
      turnReader(runtime, context, attempt, checkpoint),
    );
    await executeStep(deps, runtime, context, input, attempt, step);
  } catch (error) {
    if (runtime.signal.aborted) throw error;
    logWarn("review_orchestrator_phase_failed", {
      workId: input.workId,
      attemptNo: input.attemptNo,
      message: errorMessage(error),
    });
    failAttempt(deps, input, error);
    await disposeLive(deps, input);
    await runtime.commit(
      () => ({
        status: "terminal" as const,
        outcome: { status: "failed" as const, error: { message: errorMessage(error) } },
      }),
      context,
    );
  }
}

export const ReviewOrchestratorTask = defineTask<
  ReviewOrchestratorInput,
  ReviewTaskState,
  ReviewTaskResult
>({
  name: "pr.review_orchestrator",
  version: 1,
  initial: () => ({ phase: "recon" }),
  phases: {
    recon: runReviewTaskPhase,
    dispatch_specialists: runReviewTaskPhase,
    wait_specialists: runReviewTaskPhase,
    synthesize_and_validate: runReviewTaskPhase,
    publish: runReviewTaskPhase,
  },
  abort: async (task, runtime, ctx) => {
    const deps = boundDeps;
    if (deps !== undefined) {
      const run = workRunById(deps.db, task.input.workId);
      if (run !== undefined && run.status === "running")
        cancelAttemptRow(deps.db, task.input, deps.now?.() ?? Date.now());
      await disposeLive(deps, task.input);
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

export const reviewOrchestratorExtension = defineExtension({
  name: "pr-review-orchestrator",
  tasks: [ReviewOrchestratorTask],
});

export type ReviewAttemptStart = {
  readonly conversationId: string;
  readonly taskId: string;
  readonly markedRunning: boolean;
};

export function bindReviewOrchestrator(deps: WorkerDeps) {
  boundDeps = deps;
  if (deps.runtime.registry.snapshot().task(ReviewOrchestratorTask.definition.name) === undefined) {
    deps.runtime.registry.install(reviewOrchestratorExtension);
  }
}

export async function startReviewAttempt(deps: WorkerDeps, claim: ClaimedWorkRun) {
  bindReviewOrchestrator(deps);
  const input: ReviewOrchestratorInput = {
    workId: claim.run.work_id,
    attemptNo: claim.attempt.attempt_no,
    attemptId: claim.attempt.attempt_id,
    prKey: claim.run.pr_key,
  };
  const started = await startAttemptTask({
    harness: deps.runtime.handle.harness,
    context: BACKGROUND_CONTEXT,
    db: deps.db,
    claim,
    task: ReviewOrchestratorTask,
    input,
    now: deps.now?.() ?? Date.now(),
  });
  return {
    conversationId: started.conversationId,
    taskId: String(started.taskId),
    taskHandleId: started.taskId,
    markedRunning: started.markedRunning,
  };
}

export function createReviewAttemptHandler(deps: WorkerDeps) {
  bindReviewOrchestrator(deps);
  return ((pinnedReturn: ReviewAttemptHandler) => pinnedReturn)(async (claim) => {
    const started = await startReviewAttempt(deps, claim);
    if (!started.markedRunning) return;
    await deps.runtime.handle.harness.waitForTask(started.taskHandleId, BACKGROUND_CONTEXT);
  });
}
