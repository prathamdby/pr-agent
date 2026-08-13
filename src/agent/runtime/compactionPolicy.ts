import type { AgentSessionRole, CompactionPolicy } from "./types.js";

const COMPACTION_ENABLED = {
  orchestrator: false,
  specialist: false,
  ci_summary: false,
  ask: true,
  triage: true,
  description: true,
  verification: true,
} satisfies Record<AgentSessionRole, boolean>;

/** SDK auto-compaction enabled flag by agent role (prompt-cache prefix safety). */
export function compactionPolicyForRole(role: AgentSessionRole): CompactionPolicy {
  return { enabled: COMPACTION_ENABLED[role] };
}
