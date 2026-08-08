import type { AgentSessionPhase } from "../../agent/runtime/types.js";

export const ORCHESTRATOR_PHASE_TOOLS = [
  "submit_specialist_brief",
  "publish_thread",
  "publish_summary",
] as const;

export type OrchestratorPhaseTool = (typeof ORCHESTRATOR_PHASE_TOOLS)[number];

export const WRONG_PHASE_TOOL_CODE = "review.tool_wrong_phase" as const;

const ALLOWED_BY_PHASE: Readonly<
  Partial<Record<AgentSessionPhase, ReadonlySet<OrchestratorPhaseTool>>>
> = {
  recon: new Set(["submit_specialist_brief"]),
  judgment: new Set(["publish_thread"]),
  synthesis: new Set(["publish_summary"]),
  validation_repair: new Set(["publish_summary"]),
  publish_recovery: new Set(["publish_summary"]),
};

export type PhaseToolGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: typeof WRONG_PHASE_TOOL_CODE;
      readonly toolName: OrchestratorPhaseTool;
      readonly phase: AgentSessionPhase;
      readonly allowed: readonly OrchestratorPhaseTool[];
      readonly error: string;
    };

export type OrchestratorPhaseRef = {
  current: AgentSessionPhase;
};

export function createOrchestratorPhaseRef(
  initial: AgentSessionPhase = "recon",
): OrchestratorPhaseRef {
  return { current: initial };
}

export function allowedPhaseTools(phase: AgentSessionPhase): readonly OrchestratorPhaseTool[] {
  const allowed = ALLOWED_BY_PHASE[phase];
  return allowed ? [...allowed] : [];
}

export function assertPhaseToolAllowed(
  phase: AgentSessionPhase,
  toolName: OrchestratorPhaseTool,
): PhaseToolGateResult {
  const allowed = ALLOWED_BY_PHASE[phase];
  if (allowed?.has(toolName)) return { ok: true };
  const allowedList = allowedPhaseTools(phase);
  return {
    ok: false,
    code: WRONG_PHASE_TOOL_CODE,
    toolName,
    phase,
    allowed: allowedList,
    error: `Tool ${toolName} is not allowed during phase ${phase}. Allowed: ${
      allowedList.length > 0 ? allowedList.join(", ") : "(none)"
    }.`,
  };
}

export function gateOrchestratorPhaseTool(
  phaseRef: OrchestratorPhaseRef,
  toolName: OrchestratorPhaseTool,
): PhaseToolGateResult {
  return assertPhaseToolAllowed(phaseRef.current, toolName);
}
