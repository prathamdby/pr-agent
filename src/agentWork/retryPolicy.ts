import { isCancelAbortError } from "../agent/providers/providerErrors.js";
import { resolveModelPolicy } from "../agent/runtime/modelPolicy.js";
import type { ModelAssignment } from "../agent/runtime/types.js";
import type { Config } from "../config.js";
import { isAppError } from "../errors/appError.js";
import {
  ESCALATED_TOOL_ROUNDS_CAP,
  ESCALATED_TOOL_ROUNDS_MULTIPLIER,
  MAX_ESCALATED_VERIFICATION_INVENTORY,
} from "../settings/index.js";
import { isStaleHeadReplacementExhausted } from "./reviewReschedule.js";

/** Whether a failed attempt may return to the queue, and under which budget. */
export type RetryDisposition = "transient" | "deterministic" | "terminal";

/**
 * Runs that ended without a valid terminal submit after their own repair loops. The
 * model already saw the validation error and could not fix it, so an identical replay
 * cannot submit either.
 */
const DETERMINISTIC_FAILURE_CODES: ReadonlySet<string> = new Set([
  "verification.missing_submit",
  "triage.missing_submit",
  "review.specialist_invalid_report",
]);

export function retryDispositionFor(error: unknown): RetryDisposition {
  // One-shot stale-head replacement: a second replay can only repeat the same stale head.
  if (isStaleHeadReplacementExhausted(error)) return "terminal";
  if (isCancelAbortError(error)) return "terminal";
  if (isAppError(error) && DETERMINISTIC_FAILURE_CODES.has(error.code)) return "deterministic";
  // Everything classifyProviderError and classifyGithubError can return keeps its queue
  // budget: transport, 5xx, rate limit, timeout, auth, quota, billing, and unknown.
  // Timeout is intentionally transient — unlike the deleted fallback-eligibility table,
  // which folded it into a deadline-ineligible branch.
  return "transient";
}

export type EscalationKind = "tool_rounds" | "fallback_model";

/** Deterministic escalation for attempts after the first. Undefined means "attempt 1, unchanged". */
export type EscalationPlan = {
  readonly attempt: number;
  readonly kinds: readonly EscalationKind[];
  readonly model?: ModelAssignment;
};

export function escalationForAttempt(attempt: number, cfg: Config): EscalationPlan | undefined {
  if (attempt <= 1) return undefined;
  const fallback = resolveModelPolicy(cfg).fallback;
  return {
    attempt,
    kinds: fallback ? ["tool_rounds", "fallback_model"] : ["tool_rounds"],
    model: fallback,
  };
}

export function escalatedToolRounds(base: number, plan: EscalationPlan | undefined): number {
  if (!plan) return base;
  return Math.min(Math.ceil(base * ESCALATED_TOOL_ROUNDS_MULTIPLIER), ESCALATED_TOOL_ROUNDS_CAP);
}

/**
 * Bounded subset for an escalated verification attempt. The caller passes the
 * inventory in its canonical oldest-first order, so the subset is deterministic
 * for a given inventory and attempt count.
 */
export function escalatedVerificationInventory<T>(
  inventory: readonly T[],
  plan: EscalationPlan | undefined,
): readonly T[] {
  if (!plan) return inventory;
  return inventory.slice(0, MAX_ESCALATED_VERIFICATION_INVENTORY);
}
