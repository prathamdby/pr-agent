import { isCancelAbortError } from "../agent/providers/providerErrors.js";
import { resolveModelPolicy } from "../agent/runtime/modelPolicy.js";
import type { ModelAssignment } from "../agent/runtime/types.js";
import {
  type Config,
  ESCALATED_TOOL_ROUNDS_CAP,
  ESCALATED_TOOL_ROUNDS_MULTIPLIER,
  MAX_ESCALATED_VERIFICATION_INVENTORY,
} from "../settings/index.js";
import { isAppError } from "../errors/appError.js";
import type { AppErrorCode } from "../errors/appErrorCodes.js";
import { isStaleHeadReplacementExhausted } from "./reviewReschedule.js";

export type RetryDisposition = "transient" | "deterministic" | "terminal";

const DETERMINISTIC_FAILURE_CODES: ReadonlySet<AppErrorCode> = new Set([
  "verification.missing_submit",
  "triage.missing_submit",
  "review.specialist_invalid_report",
]);

export function retryDispositionFor(error: unknown): RetryDisposition {
  if (isStaleHeadReplacementExhausted(error)) return "terminal";
  if (isCancelAbortError(error)) return "terminal";
  if (isAppError(error) && error.code === "agent_work.attempts_exhausted") return "terminal";
  if (
    isAppError(error) &&
    (error.code === "github.essential_access_denied" || error.code === "github.preflight_exhausted")
  ) {
    return "terminal";
  }
  if (isAppError(error) && error.code === "github.review_thread_resolution_denied") {
    return "terminal";
  }
  if (
    isAppError(error) &&
    error.code === "operation_intent.mutation_outcome_unknown" &&
    error.context.unknownResolution === "terminal"
  ) {
    return "terminal";
  }
  if (isAppError(error) && DETERMINISTIC_FAILURE_CODES.has(error.code)) return "deterministic";
  return "transient";
}

export function maxAttempts(cfg: Pick<Config, "queue">): number {
  return cfg.queue.retryLimit + 1;
}

export type EscalationKind = "tool_rounds" | "fallback_model";

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

export function escalatedVerificationInventory<T>(
  inventory: readonly T[],
  plan: EscalationPlan | undefined,
): readonly T[] {
  if (!plan) return inventory;
  return inventory.slice(0, MAX_ESCALATED_VERIFICATION_INVENTORY);
}
