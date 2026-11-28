import { isCancelAbortError } from "../agent/providers/providerErrors.ts";
import { resolveModelPolicy } from "../agent/runtime/modelPolicy.ts";
import type { ModelAssignment } from "../agent/runtime/types.ts";
import {
  type Config,
  ESCALATED_TOOL_ROUNDS_CAP,
  ESCALATED_TOOL_ROUNDS_MULTIPLIER,
  MAX_ESCALATED_VERIFICATION_INVENTORY,
} from "../settings/index.ts";
import { isAppError } from "../errors/appError.ts";
import type { AppErrorCode } from "../errors/appErrorCodes.ts";
import { workspaceGitFailureKind } from "../prWorkspace/repositoryReader.ts";
import { isStaleHeadReplacementExhausted } from "./reviewReschedule.ts";

export type RetryDisposition = "transient" | "deterministic" | "terminal";

const DETERMINISTIC_FAILURE_CODES: ReadonlySet<AppErrorCode> = new Set([
  "verification.missing_submit",
  "triage.missing_submit",
  "review.specialist_invalid_report",
]);

export function retryDispositionFor(error: unknown) {
  if (isStaleHeadReplacementExhausted(error))
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  if (isCancelAbortError(error))
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  if (isAppError(error) && error.code === "agent_work.attempts_exhausted")
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  if (
    isAppError(error) &&
    (error.code === "github.essential_access_denied" || error.code === "github.preflight_exhausted")
  ) {
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  }
  if (isAppError(error) && error.code === "github.review_thread_resolution_denied") {
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  }
  if (
    isAppError(error) &&
    error.code === "operation_intent.mutation_outcome_unknown" &&
    error.context.unknownResolution === "terminal"
  ) {
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  }
  if (isAppError(error) && error.code === "pr_workspace.fetch_too_large")
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  const gitFailureKind = workspaceGitFailureKind(error);
  if (gitFailureKind === "auth" || gitFailureKind === "missing_ref")
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("terminal");
  if (isAppError(error) && DETERMINISTIC_FAILURE_CODES.has(error.code))
    return ((pinnedReturn: RetryDisposition) => pinnedReturn)("deterministic");
  return ((pinnedReturn: RetryDisposition) => pinnedReturn)("transient");
}

export function maxAttempts(cfg: Pick<Config, "queue">) {
  return ((pinnedReturn: number) => pinnedReturn)(cfg.queue.retryLimit + 1);
}

export type EscalationKind = "tool_rounds" | "fallback_model";

export type EscalationPlan = {
  readonly attempt: number;
  readonly kinds: readonly EscalationKind[];
  readonly model?: ModelAssignment;
};

export function escalationForAttempt(attempt: number, cfg: Config) {
  if (attempt <= 1) return ((pinnedReturn: EscalationPlan | undefined) => pinnedReturn)(undefined);
  const fallback = resolveModelPolicy(cfg).fallback;
  return ((pinnedReturn: EscalationPlan | undefined) => pinnedReturn)({
    attempt,
    kinds: fallback ? ["tool_rounds", "fallback_model"] : ["tool_rounds"],
    model: fallback,
  });
}

export function escalatedToolRounds(base: number, plan: EscalationPlan | undefined) {
  if (!plan) return ((pinnedReturn: number) => pinnedReturn)(base);
  return ((pinnedReturn: number) => pinnedReturn)(
    Math.min(Math.ceil(base * ESCALATED_TOOL_ROUNDS_MULTIPLIER), ESCALATED_TOOL_ROUNDS_CAP),
  );
}

export function escalatedVerificationInventory<T>(
  inventory: readonly T[],
  plan: EscalationPlan | undefined,
) {
  if (!plan) return ((pinnedReturn: readonly T[]) => pinnedReturn)(inventory);
  return ((pinnedReturn: readonly T[]) => pinnedReturn)(
    inventory.slice(0, MAX_ESCALATED_VERIFICATION_INVENTORY),
  );
}
