import type { Config } from "../../settings/index.ts";
import type { AgentSessionRole, ModelAssignment } from "./types.ts";

export type ResolvedModelPolicy = {
  readonly orchestratorPrimary: ModelAssignment;
  readonly generalPrimary: ModelAssignment;
  readonly fallback: ModelAssignment | undefined;
};

export function resolveModelPolicy(cfg: Config): ResolvedModelPolicy {
  const generalPrimary: ModelAssignment = {
    provider: cfg.models.provider,
    model: cfg.models.model,
  };
  const orchestratorPrimary: ModelAssignment = {
    provider: cfg.models.orchestratorProvider || cfg.models.provider,
    model: cfg.models.orchestratorModel || cfg.models.model,
  };
  const fallbackProvider = cfg.models.fallbackProvider.trim();
  const fallbackModel = cfg.models.fallbackModel.trim();
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
