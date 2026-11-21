import type { AgentSessionRole, CompactionPolicy } from "./types.ts";

const COMPACTION_ENABLED: Readonly<Record<AgentSessionRole, boolean>> = {
  orchestrator: false,
  specialist: true,
  ci_summary: false,
  ask: true,
  triage: true,
  description: true,
  verification: true,
};

export function compactionPolicyForRole(role: AgentSessionRole) {
  return ((pinnedReturn: CompactionPolicy) => pinnedReturn)({ enabled: COMPACTION_ENABLED[role] });
}
