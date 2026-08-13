import type { ClassifiedFailure } from "../../errors/classifiedFailure.js";
import type { AgentLifecycleEvent } from "./lifecycleEvents.js";

export type AgentAuditRecord = {
  readonly source: "agent_lifecycle";
  readonly kind: AgentLifecycleEvent["kind"];
  readonly role: AgentLifecycleEvent["role"];
  readonly phase?: string;
  readonly checkpointId?: string;
  readonly toolName?: string;
  readonly provider: string;
  readonly model: string;
  readonly ok?: boolean;
  readonly failureCode?: string;
  readonly failureDomain?: string;
  readonly errorKind?: string;
  readonly reason?: string;
  readonly attempt?: number;
  readonly recordedAt: string;
};

type MutableAgentAuditRecord = {
  -readonly [K in keyof AgentAuditRecord]: AgentAuditRecord[K];
};

/** Derive a metadata-only audit record from a sanitized lifecycle event. */
export function agentAuditRecordFromLifecycleEvent(
  event: AgentLifecycleEvent,
  now: () => Date = () => new Date(),
): AgentAuditRecord {
  const result: MutableAgentAuditRecord = {
    source: "agent_lifecycle",
    kind: event.kind,
    role: event.role,
    provider: event.provider,
    model: event.model,
    recordedAt: now().toISOString(),
  };

  switch (event.kind) {
    case "turn":
      result.phase = event.phase;
      result.checkpointId = event.checkpointId;
      return result;
    case "tool":
      result.toolName = event.toolName;
      if (event.phase) result.phase = event.phase;
      if (event.checkpointId) result.checkpointId = event.checkpointId;
      if (event.ok != null) result.ok = event.ok;
      return result;
    case "retry":
      result.reason = event.reason;
      if (event.checkpointId) result.checkpointId = event.checkpointId;
      if (event.attempt != null) result.attempt = event.attempt;
      return result;
    case "compaction":
      result.reason = event.reason;
      return result;
    case "usage":
      if (event.phase) result.phase = event.phase;
      return result;
    case "cancellation":
      result.reason = event.reason;
      return result;
    case "completion":
      result.ok = true;
      if (event.phase) result.phase = event.phase;
      if (event.checkpointId) result.checkpointId = event.checkpointId;
      return result;
    case "failure":
      result.ok = false;
      result.failureCode = event.failureCode;
      if (event.phase) result.phase = event.phase;
      if (event.checkpointId) result.checkpointId = event.checkpointId;
      if (event.failureDomain) result.failureDomain = event.failureDomain;
      if (event.errorKind) result.errorKind = event.errorKind;
      return result;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Attach classified failure taxonomy fields onto a failure lifecycle event. */
export function failureEventFromClassified(
  base: Omit<Extract<AgentLifecycleEvent, { kind: "failure" }>, "failureDomain" | "errorKind">,
  classified: ClassifiedFailure,
): Extract<AgentLifecycleEvent, { kind: "failure" }> {
  return {
    ...base,
    failureDomain: classified.failureDomain,
    errorKind: classified.errorKind,
    failureCode: classified.errorCode ?? base.failureCode,
  };
}
