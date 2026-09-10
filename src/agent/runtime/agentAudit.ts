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
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly admittedHostCalls?: number;
  readonly completedHostCalls?: number;
  readonly transferredBytes?: number;
  readonly outputBytes?: number;
  readonly recordedAt: string;
};

/** Derive a metadata-only audit record from a sanitized lifecycle event. */
export function agentAuditRecordFromLifecycleEvent(
  event: AgentLifecycleEvent,
  now: () => Date = () => new Date(),
): AgentAuditRecord {
  const base = {
    source: "agent_lifecycle" as const,
    kind: event.kind,
    role: event.role,
    provider: event.provider,
    model: event.model,
    recordedAt: now().toISOString(),
  };

  switch (event.kind) {
    case "turn":
      return {
        ...base,
        phase: event.phase,
        checkpointId: event.checkpointId,
      };
    case "tool":
      return {
        ...base,
        ...(event.phase ? { phase: event.phase } : {}),
        ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
        toolName: event.toolName,
        ...(event.ok != null ? { ok: event.ok } : {}),
      };
    case "retry":
      return {
        ...base,
        ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
        reason: event.reason,
        ...(event.attempt != null ? { attempt: event.attempt } : {}),
      };
    case "compaction":
      return { ...base, reason: event.reason };
    case "usage":
      return {
        ...base,
        ...(event.phase ? { phase: event.phase } : {}),
      };
    case "cancellation":
      return { ...base, reason: event.reason };
    case "completion":
      return {
        ...base,
        ...(event.phase ? { phase: event.phase } : {}),
        ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
        ok: true,
      };
    case "failure":
      return {
        ...base,
        ...(event.phase ? { phase: event.phase } : {}),
        ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
        ok: false,
        failureCode: event.failureCode,
        ...(event.failureDomain ? { failureDomain: event.failureDomain } : {}),
        ...(event.errorKind ? { errorKind: event.errorKind } : {}),
      };
    case "execution":
      return {
        ...base,
        ok: event.outcome === "success",
        failureCode: event.errorCode,
        reason: event.terminationReason,
        outcome: event.outcome,
        durationMs: event.durationMs,
        admittedHostCalls: event.admittedHostCalls,
        completedHostCalls: event.completedHostCalls,
        transferredBytes: event.transferredBytes,
        outputBytes: event.outputBytes,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
