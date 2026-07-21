import type {
  AgentRunnerSendOptions,
  AgentRunnerSession,
  AgentRunnerTurn,
} from "../../agent/providers/interface.js";
import { AppError, isAppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { sendReviewAgentTurn } from "../run/reviewRunAgentSend.js";

export type OrchestratorSendFailureReason = "deadline" | "superseded" | "failed" | "skipped";

export type OrchestratorSendResult =
  | { readonly ok: true; readonly turn: AgentRunnerTurn }
  | {
      readonly ok: false;
      readonly error: AppError;
      readonly reason: OrchestratorSendFailureReason;
    };

/**
 * Send once; on throw retry once. Races each attempt against the hard run deadline only
 * (decision 17/18). External cheap cancel is owned by {@link RunAbortScope}'s monitor, which
 * calls `session.abort()` — this path does not poll `shouldCancelRun`. Clears every timer
 * before returning. Never throws.
 */
export async function sendOrchestratorTurnOnceWithRetry(params: {
  readonly session: AgentRunnerSession;
  readonly prompt: string;
  readonly opts?: AgentRunnerSendOptions;
  readonly phase: string;
  /** When false, skip the send entirely (deadline / abort). */
  readonly shouldSend: () => boolean;
  readonly deadlineAtMs: number;
  readonly now: () => number;
}): Promise<OrchestratorSendResult> {
  if (!params.shouldSend()) {
    return {
      ok: false,
      reason: "skipped",
      error: new AppError({
        code: "review.orchestrator_send_skipped",
        message: `Orchestrator ${params.phase} send skipped (deadline or abort)`,
        context: { phase: params.phase },
      }),
    };
  }

  try {
    const turn = await sendOnceRacingDeadline(params);
    return { ok: true, turn };
  } catch (firstError) {
    const firstReason = failureReasonFromUnknown(firstError);
    if (firstReason === "deadline" || firstReason === "superseded") {
      return {
        ok: false,
        reason: firstReason,
        error: toSendError(params.phase, firstError, firstReason),
      };
    }
    logWarn("review_orchestrator_send_retry", {
      phase: params.phase,
      message: firstError instanceof Error ? firstError.message : String(firstError),
    });
    if (!params.shouldSend()) {
      return {
        ok: false,
        reason: "skipped",
        error: toSendError(params.phase, firstError, "skipped"),
      };
    }
    try {
      const turn = await sendOnceRacingDeadline(params);
      return { ok: true, turn };
    } catch (secondError) {
      const reason = failureReasonFromUnknown(secondError) ?? "failed";
      logWarn("review_orchestrator_send_failed", {
        phase: params.phase,
        message: secondError instanceof Error ? secondError.message : String(secondError),
        reason,
      });
      return {
        ok: false,
        reason,
        error: toSendError(params.phase, secondError, reason),
      };
    }
  }
}

async function sendOnceRacingDeadline(params: {
  readonly session: AgentRunnerSession;
  readonly prompt: string;
  readonly opts?: AgentRunnerSendOptions;
  readonly phase: string;
  readonly deadlineAtMs: number;
  readonly now: () => number;
}): Promise<AgentRunnerTurn> {
  const remainingMs = params.deadlineAtMs - params.now();
  if (remainingMs <= 0) {
    params.session.abort();
    throw new AppError({
      code: "review.orchestrator_send_deadline",
      message: `Orchestrator ${params.phase} send aborted: hard deadline already passed`,
      context: { phase: params.phase, reason: "deadline" },
    });
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadlineAbort = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      params.session.abort();
      reject(
        new AppError({
          code: "review.orchestrator_send_deadline",
          message: `Orchestrator ${params.phase} send aborted at hard deadline`,
          context: { phase: params.phase, reason: "deadline" },
        }),
      );
    }, remainingMs);
  });

  try {
    return await Promise.race([
      sendReviewAgentTurn(params.session, params.prompt, params.opts),
      deadlineAbort,
    ]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

function failureReasonFromUnknown(error: unknown): OrchestratorSendFailureReason | undefined {
  if (!isAppError(error)) return undefined;
  const reason = error.context?.reason;
  if (reason === "deadline" || reason === "superseded") return reason;
  if (error.code === "review.orchestrator_send_deadline") return "deadline";
  if (error.code === "review.orchestrator_send_superseded") return "superseded";
  if (error.code === "review.orchestrator_send_skipped") return "skipped";
  return undefined;
}

function toSendError(
  phase: string,
  error: unknown,
  reason: OrchestratorSendFailureReason,
): AppError {
  if (isAppError(error)) {
    return new AppError({
      code: error.code,
      message: error.message,
      context: { ...error.context, phase, reason },
      cause: error.cause ?? error,
    });
  }
  return new AppError({
    code: "review.orchestrator_send_failed",
    message: error instanceof Error ? error.message : String(error),
    context: { phase, reason },
    cause: error,
  });
}
