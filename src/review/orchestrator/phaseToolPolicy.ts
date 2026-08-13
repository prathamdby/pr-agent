import type { AgentSessionPhase } from "../../agent/runtime/types.js";

export const ORCHESTRATOR_PHASE_TOOLS = [
  "submit_specialist_brief",
  "publish_thread",
  "publish_summary",
] as const;

export type OrchestratorPhaseTool = (typeof ORCHESTRATOR_PHASE_TOOLS)[number];

export const WRONG_PHASE_TOOL_CODE = "review.tool_wrong_phase" as const;

const ALLOWED_BY_PHASE = {
  recon: new Set(["submit_specialist_brief"]),
  judgment: new Set(["publish_thread"]),
  synthesis: new Set(["publish_summary"]),
  validation_repair: new Set(["publish_summary"]),
  publish_recovery: new Set(["publish_summary"]),
} satisfies Partial<Record<AgentSessionPhase, ReadonlySet<OrchestratorPhaseTool>>>;

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

function allowedToolsForPhase(
  phase: AgentSessionPhase,
): ReadonlySet<OrchestratorPhaseTool> | undefined {
  if (phase === "recon") return ALLOWED_BY_PHASE.recon;
  if (phase === "judgment") return ALLOWED_BY_PHASE.judgment;
  if (phase === "synthesis") return ALLOWED_BY_PHASE.synthesis;
  if (phase === "validation_repair") return ALLOWED_BY_PHASE.validation_repair;
  if (phase === "publish_recovery") return ALLOWED_BY_PHASE.publish_recovery;
  return undefined;
}

export function assertPhaseToolAllowed(
  phase: AgentSessionPhase,
  toolName: OrchestratorPhaseTool,
): PhaseToolGateResult {
  const allowed = allowedToolsForPhase(phase);
  if (allowed?.has(toolName)) return { ok: true };
  const allowedList = allowed ? [...allowed] : [];
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
