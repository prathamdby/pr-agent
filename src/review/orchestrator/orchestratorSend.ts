import type {
  AgentRunnerSendOptions,
  AgentRunnerSession,
  AgentRunnerTurn,
} from "../../agent/providers/interface.js";
import { AppError, isAppError } from "../../errors/appError.js";
import { logWarn } from "../../evlog.js";
import { ORCHESTRATOR_SEND_ABORT_POLL_MS } from "../../settings/index.js";
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
 * Send once; on throw retry once. Races each attempt against the hard run deadline and a
 * bounded external-abort poll (decision 17/18). Calls `session.abort()` on deadline/supersede
 * and clears every timer before returning. Never throws.
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
  readonly sleep: (ms: number) => Promise<void>;
  /** Cooperative cheap cancel probe while send is in flight (no GitHub / stale-head). */
  readonly shouldAbortExternal?: () => Promise<boolean>;
  readonly abortPollMs?: number;
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

/** Sleep that settles early when `signal` aborts (stops poll spins / retained waits). */
function sleepUntilAbortOrTimeout(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void sleep(ms).then(finish, finish);
  });
}

async function sendOnceRacingDeadline(params: {
  readonly session: AgentRunnerSession;
  readonly prompt: string;
  readonly opts?: AgentRunnerSendOptions;
  readonly phase: string;
  readonly deadlineAtMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly shouldAbortExternal?: () => Promise<boolean>;
  readonly abortPollMs?: number;
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
  const pollAbort = new AbortController();
  const abortPollMs = params.abortPollMs ?? ORCHESTRATOR_SEND_ABORT_POLL_MS;

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

  const races: Promise<AgentRunnerTurn>[] = [
    sendReviewAgentTurn(params.session, params.prompt, params.opts),
    deadlineAbort,
  ];

  let pollPromise: Promise<AgentRunnerTurn> | undefined;
  if (params.shouldAbortExternal) {
    const shouldAbortExternal = params.shouldAbortExternal;
    pollPromise = (async (): Promise<AgentRunnerTurn> => {
      while (!pollAbort.signal.aborted) {
        await sleepUntilAbortOrTimeout(params.sleep, abortPollMs, pollAbort.signal);
        if (pollAbort.signal.aborted) break;
        let abort = false;
        try {
          abort = await shouldAbortExternal();
        } catch {
          abort = true;
        }
        if (pollAbort.signal.aborted) break;
        if (abort) {
          params.session.abort();
          throw new AppError({
            code: "review.orchestrator_send_superseded",
            message: `Orchestrator ${params.phase} send aborted: work superseded or cancelled`,
            context: { phase: params.phase, reason: "superseded" },
          });
        }
      }
      // Another race branch won — settle without producing a turn.
      throw new AppError({
        code: "review.orchestrator_send_poll_cancelled",
        message: "Orchestrator send abort poll cancelled",
        context: { phase: params.phase, reason: "skipped" },
      });
    })();
    races.push(pollPromise);
  }

  try {
    return await Promise.race(races);
  } finally {
    pollAbort.abort();
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    // Drain the poll so it settles and does not retain the race closures.
    if (pollPromise != null) {
      await pollPromise.catch(() => undefined);
    }
  }
}

function failureReasonFromUnknown(error: unknown): OrchestratorSendFailureReason | undefined {
  if (!isAppError(error)) return undefined;
  const reason = error.context?.reason;
  if (reason === "deadline" || reason === "superseded") return reason;
  if (error.code === "review.orchestrator_send_deadline") return "deadline";
  if (error.code === "review.orchestrator_send_superseded") return "superseded";
  if (error.code === "review.orchestrator_send_skipped") return "skipped";
  if (error.code === "review.orchestrator_send_poll_cancelled") return "skipped";
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
