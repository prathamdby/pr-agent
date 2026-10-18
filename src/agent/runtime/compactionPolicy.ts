import type { AgentSessionRole, CompactionPolicy } from "./types.ts";

const COMPACTION_ENABLED: Readonly<Record<AgentSessionRole, boolean>> = {
  orchestrator: false,
  specialist: false,
  ci_summary: false,
  ask: true,
  triage: true,
  description: true,
  verification: true,
};

export function compactionPolicyForRole(role: AgentSessionRole): CompactionPolicy {
  return { enabled: COMPACTION_ENABLED[role] };
}
