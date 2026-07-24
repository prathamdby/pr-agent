import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import type { AgentSessionRole, ModelAssignment } from "./types.js";

export type ResolvedModelPolicy = {
  readonly orchestratorPrimary: ModelAssignment;
  readonly generalPrimary: ModelAssignment;
  readonly fallback: ModelAssignment | undefined;
};

export function resolveModelPolicy(cfg: Config): ResolvedModelPolicy {
  const generalPrimary: ModelAssignment = {
    provider: cfg.piProvider,
    model: cfg.piModel,
  };
  const orchestratorPrimary: ModelAssignment = {
    provider: cfg.piOrchestratorProvider || cfg.piProvider,
    model: cfg.piOrchestratorModel || cfg.piModel,
  };
  const fallbackProvider = cfg.piFallbackProvider.trim();
  const fallbackModel = cfg.piFallbackModel.trim();
  const fallback =
    fallbackProvider && fallbackModel
      ? { provider: fallbackProvider, model: fallbackModel }
      : undefined;

  return { orchestratorPrimary, generalPrimary, fallback };
}

export function modelAssignmentForRole(
  policy: ResolvedModelPolicy,
  role: AgentSessionRole,
): ModelAssignment {
  switch (role) {
    case "orchestrator":
      return policy.orchestratorPrimary;
    case "specialist":
    case "ask":
    case "description":
    case "triage":
    case "verification":
    case "ci_summary":
      return policy.generalPrimary;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/** Guard: a healthy live session must not switch models mid-conversation. */
export function assertSameModelAssignment(
  current: ModelAssignment,
  next: ModelAssignment,
  context: { readonly role: AgentSessionRole; readonly reason: string },
): void {
  if (current.provider === next.provider && current.model === next.model) return;
  throw new AppError({
    code: "runtime.mid_session_model_switch",
    message: "Healthy Pi sessions keep one model; mid-session model switches are forbidden",
    context: {
      role: context.role,
      reason: context.reason,
      currentProvider: current.provider,
      currentModel: current.model,
      nextProvider: next.provider,
      nextModel: next.model,
    },
  });
}
