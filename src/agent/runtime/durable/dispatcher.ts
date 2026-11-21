import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Config } from "../../../settings/index.ts";
import * as v from "valibot";
import { immediate, readRow } from "../../../state/db.ts";
import { withPrMutex } from "../../../state/prMutex.ts";
import {
  claimDispatchableWorkRun,
  markAttemptRunning,
  markWorkRunCompleted,
  nextDispatchWakeAt,
  type ClaimedWorkRun,
  type WorkRunKind,
} from "../../../state/workRuns.ts";
import { errorMessage } from "../../../errors/errorMessage.ts";
import { logWarn } from "../../../evlog.ts";
import {
  PR_SERIALIZED_KINDS,
  isFeatureWorkKind,
  recordAttemptFailure,
  startFeatureAttempt,
  type FeatureAttemptExecutorFor,
} from "./featureAttemptTask.ts";
import type { DurableRuntime } from "./runtime.ts";

export type {
  FeatureAttemptExecutor,
  FeatureAttemptExecutorFor,
  FeatureWorkKind,
} from "./featureAttemptTask.ts";

export type ReviewAttemptHandler = (claim: ClaimedWorkRun) => Promise<void>;

export type AckHandler = (claim: ClaimedWorkRun) => Promise<void>;

export type DispatcherHandlers = {
  readonly review: ReviewAttemptHandler;
  readonly feature: FeatureAttemptExecutorFor;
  readonly ack: AckHandler;
};

export type CiProjectionRunner = (now: number) => Promise<void>;

export type Dispatcher = {
  readonly start: () => void;
  readonly notify: () => void;
  readonly pause: () => void;
  readonly drain: (timeoutMs?: number) => Promise<boolean>;
  readonly running: () => boolean;
  readonly inflightCount: (kind?: WorkRunKind | "ci_projection_timer") => number;
  readonly setCiProjectionRunner: (fn: CiProjectionRunner) => void;
};

const DISPATCH_KINDS: readonly WorkRunKind[] = [
  "review",
  "ask",
  "description",
  "triage",
  "verification",
  "ack",
  "ci_projection",
];

const IDLE_WAKE_MS = 1_000;

export function nextProjectionDueAt(db: DatabaseSync) {
  const row = readRow(
    db
      .prepare(
        `SELECT MIN(next_projection_at) AS due_at FROM pr_head_ci_state
          WHERE next_projection_at IS NOT NULL`,
      )
      .get(),
    v.object({ due_at: v.nullable(v.number()) }),
  );
  return ((pinnedReturn: number | undefined) => pinnedReturn)(row?.due_at ?? undefined);
}

export function pendingCiProjectionCount(db: DatabaseSync) {
  const row = readRow(
    db
      .prepare(
        `SELECT COUNT(*) AS pending FROM pr_head_ci_state WHERE next_projection_at IS NOT NULL`,
      )
      .get(),
    v.object({ pending: v.number() }),
  );
  return ((pinnedReturn: number) => pinnedReturn)(row?.pending ?? 0);
}
const CI_PROJECTION_TIMER_KEY = "ci_projection_timer";

function kindConcurrency(cfg: Config, kind: WorkRunKind) {
  switch (kind) {
    case "review":
      return cfg.concurrency.review;
    case "ask":
      return cfg.concurrency.ask;
    case "ack":
      return cfg.concurrency.ack;
    case "description":
      return cfg.concurrency.description;
    case "triage":
      return cfg.concurrency.triage;
    case "verification":
      return cfg.concurrency.verification;
    case "ci_projection":
      return 1;
  }
  const unreachable: never = kind;
  throw new Error("unhandled work run kind " + String(unreachable));
}

export function createDispatcher(deps: {
  readonly db: DatabaseSync;
  readonly cfg: Config;
  readonly handlers: DispatcherHandlers;
  readonly runtime: () => DurableRuntime;
  readonly context?: Context;
  readonly now?: () => number;
  readonly idleWakeMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const context = deps.context ?? BACKGROUND_CONTEXT;
  const idleWakeMs = deps.idleWakeMs ?? IDLE_WAKE_MS;
  const inflight = new Map<string, { readonly kind: string; readonly done: Promise<void> }>();
  let ciProjectionRunner: CiProjectionRunner | undefined;
  let active = false;
  let generation = 0;
  let loopDone: Promise<void> = Promise.resolve();
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeResolve: (() => void) | undefined;

  const countKind = (kind: string) => {
    let count = 0;
    for (const entry of inflight.values()) if (entry.kind === kind) count += 1;
    return ((pinnedReturn: number) => pinnedReturn)(count);
  };

  const allowedKinds = () =>
    DISPATCH_KINDS.filter((kind) => countKind(kind) < kindConcurrency(deps.cfg, kind));

  const track = (key: string, kind: string, work: () => Promise<void>) => {
    const done = work()
      .catch((error: unknown) => {
        logWarn("work_dispatch_failed", { key, kind, message: errorMessage(error) });
      })
      .finally(() => {
        inflight.delete(key);
        notify();
      });
    inflight.set(key, { kind, done });
  };

  const failAttempt = (claim: ClaimedWorkRun, error: unknown) => {
    logWarn("work_attempt_failed", {
      workId: claim.run.work_id,
      attemptNo: claim.attempt.attempt_no,
      kind: claim.run.kind,
      message: errorMessage(error),
    });
    recordAttemptFailure(deps.db, deps.cfg, {
      workId: claim.run.work_id,
      attemptNo: claim.attempt.attempt_no,
      error,
      interrupted: false,
      now: now(),
    });
  };

  const runAck = async (claim: ClaimedWorkRun) => {
    const marked = immediate(deps.db, () =>
      markAttemptRunning(deps.db, {
        workId: claim.run.work_id,
        attemptNo: claim.attempt.attempt_no,
        conversationId: null,
        taskId: null,
        now: now(),
      }),
    );
    if (marked === 0) return;
    try {
      await deps.handlers.ack(claim);
    } catch (error) {
      failAttempt(claim, error);
      return;
    }
    immediate(deps.db, () =>
      markWorkRunCompleted(deps.db, {
        workId: claim.run.work_id,
        attemptNo: claim.attempt.attempt_no,
        now: now(),
      }),
    );
  };

  const runReview = async (claim: ClaimedWorkRun) => {
    try {
      await (PR_SERIALIZED_KINDS.has(claim.run.kind)
        ? withPrMutex(claim.run.pr_key, () => deps.handlers.review(claim))
        : deps.handlers.review(claim));
    } catch (error) {
      failAttempt(claim, error);
    }
  };

  const runFeature = async (claim: ClaimedWorkRun) => {
    const harness = deps.runtime().handle.harness;
    let started;
    try {
      started = await startFeatureAttempt({ harness, context, db: deps.db, claim, now: now() });
    } catch (error) {
      failAttempt(claim, error);
      return;
    }
    if (!started.markedRunning) return;
    await harness.waitForTask(started.taskId, context);
  };

  const dispatch = (claim: ClaimedWorkRun) => {
    const kind = claim.run.kind;
    track(claim.attempt.attempt_id, kind, () => {
      if (kind === "ack") return runAck(claim);
      if (kind === "review") return runReview(claim);
      if (isFeatureWorkKind(kind)) return runFeature(claim);
      return Promise.reject(new Error(`no dispatcher route for work kind ${String(kind)}`));
    });
  };

  const maybeRunCiProjections = () => {
    const runner = ciProjectionRunner;
    if (runner === undefined || inflight.has(CI_PROJECTION_TIMER_KEY)) return;
    const dueAt = nextProjectionDueAt(deps.db);
    const at = now();
    if (dueAt === undefined || dueAt > at) return;
    track(CI_PROJECTION_TIMER_KEY, CI_PROJECTION_TIMER_KEY, () => runner(at));
  };

  const nextWakeMs = () => {
    const at = now();
    const candidates = [nextDispatchWakeAt(deps.db)];
    if (ciProjectionRunner !== undefined && !inflight.has(CI_PROJECTION_TIMER_KEY)) {
      candidates.push(nextProjectionDueAt(deps.db));
    }
    let wake = idleWakeMs;
    for (const candidate of candidates) {
      if (candidate !== undefined) wake = Math.min(wake, Math.max(0, candidate - at));
    }
    return ((pinnedReturn: number) => pinnedReturn)(wake);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wakeResolve = resolve;
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        wakeResolve = undefined;
        resolve();
      }, ms);
    });

  const tick = () => {
    maybeRunCiProjections();
    const kinds = allowedKinds();
    if (kinds.length === 0) return false;
    const claim = immediate(deps.db, () => claimDispatchableWorkRun(deps.db, now(), { kinds }));
    if (claim === undefined) return false;
    dispatch(claim);
    return true;
  };

  const loop = async (loopGeneration: number) => {
    const current = () => active && loopGeneration === generation;
    for (;;) {
      if (!current()) return;
      let progressed = false;
      try {
        progressed = tick();
      } catch (error) {
        logWarn("work_dispatch_tick_failed", { message: errorMessage(error) });
      }
      if (!progressed && current()) {
        let waitMs = idleWakeMs;
        try {
          waitMs = nextWakeMs();
        } catch (error) {
          if (!current()) return;
          logWarn("work_dispatch_wake_failed", { message: errorMessage(error) });
        }
        if (current()) await sleep(waitMs);
      }
    }
  };

  function notify() {
    if (wakeTimer !== undefined) {
      clearTimeout(wakeTimer);
      wakeTimer = undefined;
    }
    const resolve = wakeResolve;
    wakeResolve = undefined;
    resolve?.();
  }

  const pause = () => {
    active = false;
    notify();
  };

  return ((pinnedReturn: Dispatcher) => pinnedReturn)({
    start: () => {
      if (active) return;
      active = true;
      generation += 1;
      loopDone = loop(generation);
    },
    notify,
    pause,
    drain: async (timeoutMs) => {
      pause();
      await loopDone;
      const settled = Promise.allSettled([...inflight.values()].map((entry) => entry.done)).then(
        () => true,
      );
      if (timeoutMs === undefined) return ((pinnedReturn: boolean) => pinnedReturn)(await settled);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return ((pinnedReturn: boolean) => pinnedReturn)(await Promise.race([settled, expired]));
      } finally {
        clearTimeout(timer);
      }
    },
    running: () => active,
    inflightCount: (kind) =>
      ((pinnedReturn: number) => pinnedReturn)(
        kind === undefined ? inflight.size : countKind(kind),
      ),
    setCiProjectionRunner: (fn) => {
      ciProjectionRunner = fn;
      notify();
    },
  });
}
