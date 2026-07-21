import type { AgentRunnerSession } from "../../agent/providers/interface.js";
import { AppError } from "../../errors/appError.js";
import { ORCHESTRATOR_SEND_ABORT_POLL_MS } from "../../settings/index.js";
import type { PublishAbortGate, PublishAbortKind } from "../publish/publishAbortGate.js";

export type AbortGateKind = "continue" | "deadline" | "superseded";

/**
 * One abort scope per orchestrated review run: shared AbortSignal, hard deadline,
 * cheap cancel monitor, phase/publish gates, supersede marking, and abort-aware sleep.
 * Deadline remains distinct from supersede (decision 17/19 vs 26).
 */
export type RunAbortScope = {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly markSuperseded: () => void;
  readonly isSuperseded: () => boolean;
  readonly deadlinePassed: () => boolean;
  /** True while neither superseded nor past the hard deadline. */
  readonly shouldKeepRunning: () => boolean;
  /**
   * Full pre-publish / phase gate: DB skip + stale-head (via `shouldAbortPublish`).
   * Never use on the in-flight 250ms cheap-cancel poll.
   */
  readonly gate: () => Promise<AbortGateKind>;
  /**
   * Publish-layer gate only (`continue | stale_head | superseded`).
   * Internal deadline never blocks deterministic summary through this gate.
   */
  readonly publishGate: PublishAbortGate;
  /**
   * Cheap cancel monitor (DB skip only) for the whole orchestrated run.
   * Start once at the top of the run; call `stop()` from the top-level finally.
   */
  readonly startCheapCancelMonitor: (args?: { readonly pollMs?: number }) => {
    readonly stop: () => Promise<void>;
  };
  /** Abort the shared signal and the orchestrator session (idempotent). */
  readonly abortSessions: () => void;
};

export type CreateRunAbortScopeParams = {
  readonly deadlineAtMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly session: AgentRunnerSession;
  /** Full publish gate (DB + GitHub stale-head). */
  readonly shouldAbortPublish?: () => Promise<boolean>;
  /** Mutable bag set by `shouldAbortPublish` when the head SHA moved. */
  readonly publishAbortState?: { staleHead?: boolean };
  /** Cheap cancel probe (DB only — no GitHub). */
  readonly shouldCancelRun?: () => Promise<boolean>;
};

/** Sleep that settles early when `signal` aborts (stops poll spins / retained waits). */
export function sleepUntilAbortOrTimeout(
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

function staleOrSuperseded(
  publishAbortState: { staleHead?: boolean } | undefined,
): PublishAbortKind {
  return publishAbortState?.staleHead === true ? "stale_head" : "superseded";
}

export async function checkPublishAbortGate(params: {
  readonly alreadySuperseded: boolean;
  readonly shouldAbortPublish?: () => Promise<boolean>;
  readonly publishAbortState?: { staleHead?: boolean };
  readonly onSupersede: () => void;
}): Promise<PublishAbortKind> {
  if (params.alreadySuperseded) return staleOrSuperseded(params.publishAbortState);
  if (!params.shouldAbortPublish) return "continue";
  try {
    if (await params.shouldAbortPublish()) {
      params.onSupersede();
      return staleOrSuperseded(params.publishAbortState);
    }
  } catch {
    params.onSupersede();
    return "superseded";
  }
  return "continue";
}

export function isDeadlineSpecialistError(error: AppError): boolean {
  return error.context?.reason === "deadline";
}

export function createRunAbortScope(params: CreateRunAbortScopeParams): RunAbortScope {
  const abortController = new AbortController();
  let publishSuperseded = false;

  const markSuperseded = (): void => {
    publishSuperseded = true;
    if (!abortController.signal.aborted) abortController.abort();
    params.session.abort();
  };

  const deadlinePassed = (): boolean => params.now() >= params.deadlineAtMs;

  const scope: RunAbortScope = {
    signal: abortController.signal,
    deadlineAtMs: params.deadlineAtMs,
    markSuperseded,
    isSuperseded: () => publishSuperseded,
    deadlinePassed,
    shouldKeepRunning: () => !publishSuperseded && !deadlinePassed(),
    gate: async () =>
      checkAbortGate({
        alreadySuperseded: publishSuperseded,
        deadlinePassed: deadlinePassed(),
        shouldAbortPublish: params.shouldAbortPublish,
        onSupersede: markSuperseded,
      }),
    publishGate: async () =>
      checkPublishAbortGate({
        alreadySuperseded: publishSuperseded,
        shouldAbortPublish: params.shouldAbortPublish,
        publishAbortState: params.publishAbortState,
        onSupersede: markSuperseded,
      }),
    startCheapCancelMonitor: (args) => {
      if (!params.shouldCancelRun) {
        return { stop: async () => undefined };
      }
      const shouldCancelRun = params.shouldCancelRun;
      const pollMs = args?.pollMs ?? ORCHESTRATOR_SEND_ABORT_POLL_MS;
      const monitorAbort = new AbortController();

      const promise = (async (): Promise<void> => {
        while (!monitorAbort.signal.aborted) {
          if (publishSuperseded) break;
          await sleepUntilAbortOrTimeout(params.sleep, pollMs, monitorAbort.signal);
          if (monitorAbort.signal.aborted || publishSuperseded) break;
          let cancel = false;
          try {
            cancel = await shouldCancelRun();
          } catch {
            cancel = true;
          }
          if (monitorAbort.signal.aborted) break;
          if (cancel) {
            markSuperseded();
            return;
          }
        }
      })();

      return {
        stop: async () => {
          monitorAbort.abort();
          await promise.catch(() => undefined);
        },
      };
    },
    abortSessions: () => {
      if (!abortController.signal.aborted) abortController.abort();
      params.session.abort();
    },
  };

  return scope;
}
