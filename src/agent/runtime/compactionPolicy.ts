import type { AgentSessionRole, CompactionPolicy } from "./types.js";

const COMPACTION_ENABLED: Readonly<Record<AgentSessionRole, boolean>> = {
  orchestrator: false,
  specialist: false,
  ci_summary: false,
  ask: true,
  triage: true,
  description: true,
  verification: true,
};

/** SDK auto-compaction enabled flag by agent role (prompt-cache prefix safety). */
export function compactionPolicyForRole(role: AgentSessionRole): CompactionPolicy {
  return { enabled: COMPACTION_ENABLED[role] };
}
