import type { AgentRunnerSession } from "../../agent/providers/interface.js";
import { AppError } from "../../errors/appError.js";
import { ORCHESTRATOR_SEND_ABORT_POLL_MS } from "../../settings/index.js";

export type AbortGateKind = "continue" | "deadline" | "superseded";

/**
 * External supersede/cancel/stale only. Deadline is a separate signal so the run can
 * still take the deterministic summary path (decision 17/19 vs 26).
 */
export async function probeExternalSupersede(params: {
  readonly alreadySuperseded: boolean;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly onSupersede: () => void;
}): Promise<boolean> {
  if (params.alreadySuperseded) return true;
  if (!params.shouldAbortPublish) return false;
  try {
    if (await params.shouldAbortPublish()) {
      params.onSupersede();
      return true;
    }
  } catch {
    params.onSupersede();
    return true;
  }
  return false;
}

export async function checkAbortGate(params: {
  readonly alreadySuperseded: boolean;
  readonly deadlinePassed: boolean;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly onSupersede: () => void;
}): Promise<AbortGateKind> {
  if (await probeExternalSupersede(params)) return "superseded";
  if (params.deadlinePassed) return "deadline";
  return "continue";
}

export function markOrchestratorSuperseded(params: {
  readonly abortController: AbortController;
  readonly session: AgentRunnerSession;
  readonly setSuperseded: () => void;
}): void {
  params.setSuperseded();
  if (!params.abortController.signal.aborted) params.abortController.abort();
  params.session.abort();
}

export function isDeadlineSpecialistError(error: AppError): boolean {
  return error.context?.reason === "deadline";
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

/**
 * While specialists are pending (and no orchestrator send owns the in-flight poll),
 * cheap-cancel on a bounded interval. On cancel: invoke `onCancel` (mark superseded /
 * abort shared specialist signal + orchestrator session). Call `stop()` from every
 * completion/finally path to drain the wait.
 */
export function startPendingSpecialistsCancelMonitor(params: {
  readonly shouldCancelRun?: () => Promise<boolean>;
  readonly shouldContinue: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onCancel: () => void;
  readonly pollMs?: number;
}): { readonly stop: () => Promise<void> } {
  if (!params.shouldCancelRun) {
    return { stop: async () => undefined };
  }

  const shouldCancelRun = params.shouldCancelRun;
  const pollMs = params.pollMs ?? ORCHESTRATOR_SEND_ABORT_POLL_MS;
  const abort = new AbortController();

  const promise = (async (): Promise<void> => {
    while (!abort.signal.aborted && params.shouldContinue()) {
      await sleepUntilAbortOrTimeout(params.sleep, pollMs, abort.signal);
      if (abort.signal.aborted || !params.shouldContinue()) break;
      let cancel = false;
      try {
        cancel = await shouldCancelRun();
      } catch {
        cancel = true;
      }
      if (abort.signal.aborted) break;
      if (cancel) {
        params.onCancel();
        return;
      }
    }
  })();

  return {
    stop: async () => {
      abort.abort();
      await promise.catch(() => undefined);
    },
  };
}
