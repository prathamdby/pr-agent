import {
  RUN_DEADLINE_BUDGET_FRACTION,
  SPECIALIST_DISPATCH_STAGGER_MS,
} from "../../settings/index.js";

/** Hard run deadline (ms epoch) from queue expiry wall and budget fraction (decision 17). */
export function computeRunDeadlineAtMs(params: {
  readonly nowMs: number;
  readonly queueExpireInSeconds: number;
  readonly budgetFraction?: number;
}): number {
  const fraction = params.budgetFraction ?? RUN_DEADLINE_BUDGET_FRACTION;
  return params.nowMs + Math.floor(params.queueExpireInSeconds * 1000 * fraction);
}

/**
 * Per-specialist timeout: min(config timeout, remaining budget minus that specialist's start
 * stagger). Specialists run concurrently, so dividing remaining by pending count under-budgets
 * late-staggered specialists; the hard run deadline still bounds synthesis.
 */
export function specialistTimeoutMs(params: {
  readonly nowMs: number;
  readonly deadlineAtMs: number;
  readonly configTimeoutMs: number;
  /** Delay before this specialist's first send (`index * stagger`). */
  readonly startStaggerMs?: number;
}): number {
  const stagger = Math.max(0, params.startStaggerMs ?? 0);
  const remaining = Math.max(0, params.deadlineAtMs - params.nowMs - stagger);
  return Math.min(params.configTimeoutMs, remaining);
}

export function resolveSpecialistDispatchStaggerMs(override?: number): number {
  return override ?? SPECIALIST_DISPATCH_STAGGER_MS;
}
