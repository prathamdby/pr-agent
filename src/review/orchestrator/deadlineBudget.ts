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
 * Per-specialist timeout: min(config timeout, fair share of remaining budget across
 * concurrent specialists). At one dispatch instant every specialist uses the same
 * `pendingCount` (typically 4); start stagger is handled separately via `startDelayMs`.
 */
export function specialistTimeoutMs(params: {
  readonly nowMs: number;
  readonly deadlineAtMs: number;
  readonly configTimeoutMs: number;
  readonly pendingCount: number;
}): number {
  const remaining = Math.max(0, params.deadlineAtMs - params.nowMs);
  const fairShare =
    params.pendingCount > 0 ? Math.floor(remaining / params.pendingCount) : remaining;
  return Math.min(params.configTimeoutMs, fairShare);
}

export function resolveSpecialistDispatchStaggerMs(override?: number): number {
  return override ?? SPECIALIST_DISPATCH_STAGGER_MS;
}
