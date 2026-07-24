import type { AgentSessionPhase, AgentSessionRole } from "./types.js";

export type AgentLifecycleTurnEvent = {
  readonly kind: "turn";
  readonly role: AgentSessionRole;
  readonly phase: AgentSessionPhase;
  readonly checkpointId: string;
  readonly provider: string;
  readonly model: string;
};

export type AgentLifecycleToolEvent = {
  readonly kind: "tool";
  readonly role: AgentSessionRole;
  readonly phase?: AgentSessionPhase;
  readonly checkpointId?: string;
  readonly toolName: string;
  readonly ok?: boolean;
  readonly provider: string;
  readonly model: string;
};

export type AgentLifecycleRetryEvent = {
  readonly kind: "retry";
  readonly role: AgentSessionRole;
  readonly checkpointId?: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt?: number;
  readonly reason: string;
};

export type AgentLifecycleCompactionEvent = {
  readonly kind: "compaction";
  readonly role: AgentSessionRole;
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
};

export type AgentLifecycleUsageEvent = {
  readonly kind: "usage";
  readonly role: AgentSessionRole;
  readonly phase?: AgentSessionPhase;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type AgentLifecycleCancellationEvent = {
  readonly kind: "cancellation";
  readonly role: AgentSessionRole;
  readonly provider: string;
  readonly model: string;
  readonly reason: string;
};

export type AgentLifecycleCompletionEvent = {
  readonly kind: "completion";
  readonly role: AgentSessionRole;
  readonly phase?: AgentSessionPhase;
  readonly checkpointId?: string;
  readonly provider: string;
  readonly model: string;
  readonly ok: true;
};

export type AgentLifecycleFailureEvent = {
  readonly kind: "failure";
  readonly role: AgentSessionRole;
  readonly phase?: AgentSessionPhase;
  readonly checkpointId?: string;
  readonly provider: string;
  readonly model: string;
  readonly ok: false;
  readonly failureCode: string;
  readonly failureDomain?: string;
  readonly errorKind?: string;
};

export type AgentLifecycleEvent =
  | AgentLifecycleTurnEvent
  | AgentLifecycleToolEvent
  | AgentLifecycleRetryEvent
  | AgentLifecycleCompactionEvent
  | AgentLifecycleUsageEvent
  | AgentLifecycleCancellationEvent
  | AgentLifecycleCompletionEvent
  | AgentLifecycleFailureEvent;

const ALLOWED_KINDS = new Set<AgentLifecycleEvent["kind"]>([
  "turn",
  "tool",
  "retry",
  "compaction",
  "usage",
  "cancellation",
  "completion",
  "failure",
]);

export function isAgentLifecycleEventKind(value: string): value is AgentLifecycleEvent["kind"] {
  return ALLOWED_KINDS.has(value as AgentLifecycleEvent["kind"]);
}
