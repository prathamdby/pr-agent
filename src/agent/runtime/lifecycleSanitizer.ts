import { logWarn } from "../../evlog.js";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.js";
import { isPlainObject } from "../../util/typeGuards.js";
import { isAgentLifecycleEventKind, type AgentLifecycleEvent } from "./lifecycleEvents.js";
import type { AgentSessionPhase, AgentSessionRole } from "./types.js";

const SESSION_ROLES = new Set<AgentSessionRole>([
  "orchestrator",
  "specialist",
  "ask",
  "description",
  "triage",
  "verification",
  "ci_summary",
]);

const SESSION_PHASES = new Set<AgentSessionPhase>([
  "recon",
  "specialist",
  "judgment",
  "synthesis",
  "validation_repair",
  "publish_recovery",
  "ask",
  "description",
  "triage",
  "verification",
  "ci_summary",
]);

const FORBIDDEN_KEY_RE =
  /prompt|message|text|reasoning|content|argument|result|payload|token|secret|key|authorization|cookie|body|diff|patch|errorMessage|stack|cause/i;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeStableCode(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  // Stable codes are dotted identifiers — reject free-form exception text.
  if (!/^[a-z][a-z0-9_.]{0,127}$/i.test(raw)) return undefined;
  return raw;
}

function sanitizeToolName(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/.test(raw)) return undefined;
  return raw;
}

function sanitizeReason(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const cleaned = sanitizeLogMessage(raw);
  if (!cleaned) return undefined;
  // Reject long free-form blobs that look like model/repo content.
  if (cleaned.length > 64) return cleaned.slice(0, 64);
  return cleaned;
}

type LifecycleSanitizeFields = {
  readonly role: AgentSessionRole;
  readonly provider: string;
  readonly model: string;
  readonly phase?: AgentSessionPhase;
  readonly checkpointId?: string;
  readonly raw: Record<string, unknown>;
};

function optionalFiniteNumber(
  value: unknown,
  key: "attempt" | "inputTokens" | "outputTokens" | "totalTokens",
): { readonly [K in typeof key]?: number } {
  const parsed = asFiniteNumber(value);
  return parsed != null ? { [key]: parsed } : {};
}

function sanitizeTurnEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent | null {
  if (!fields.phase || !fields.checkpointId) return null;
  return {
    kind: "turn",
    role: fields.role,
    phase: fields.phase,
    checkpointId: fields.checkpointId,
    provider: fields.provider,
    model: fields.model,
  };
}

function sanitizeToolEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent | null {
  const toolName = sanitizeToolName(fields.raw.toolName);
  if (!toolName) return null;
  return {
    kind: "tool",
    role: fields.role,
    ...(fields.phase ? { phase: fields.phase } : {}),
    ...(fields.checkpointId ? { checkpointId: fields.checkpointId } : {}),
    toolName,
    ...(typeof fields.raw.ok === "boolean" ? { ok: fields.raw.ok } : {}),
    provider: fields.provider,
    model: fields.model,
  };
}

function sanitizeRetryEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent | null {
  const reason = sanitizeReason(fields.raw.reason);
  if (!reason) return null;
  return {
    kind: "retry",
    role: fields.role,
    ...(fields.checkpointId ? { checkpointId: fields.checkpointId } : {}),
    provider: fields.provider,
    model: fields.model,
    ...optionalFiniteNumber(fields.raw.attempt, "attempt"),
    reason,
  };
}

function sanitizeCompactionEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent | null {
  const reason = sanitizeReason(fields.raw.reason);
  if (!reason) return null;
  return {
    kind: "compaction",
    role: fields.role,
    provider: fields.provider,
    model: fields.model,
    reason,
  };
}

function sanitizeUsageEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent {
  return {
    kind: "usage",
    role: fields.role,
    ...(fields.phase ? { phase: fields.phase } : {}),
    provider: fields.provider,
    model: fields.model,
    ...optionalFiniteNumber(fields.raw.inputTokens, "inputTokens"),
    ...optionalFiniteNumber(fields.raw.outputTokens, "outputTokens"),
    ...optionalFiniteNumber(fields.raw.totalTokens, "totalTokens"),
  };
}

function sanitizeCancellationEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent {
  return {
    kind: "cancellation",
    role: fields.role,
    provider: fields.provider,
    model: fields.model,
    reason: sanitizeReason(fields.raw.reason) ?? "abort",
  };
}

function sanitizeCompletionEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent {
  return {
    kind: "completion",
    role: fields.role,
    ...(fields.phase ? { phase: fields.phase } : {}),
    ...(fields.checkpointId ? { checkpointId: fields.checkpointId } : {}),
    provider: fields.provider,
    model: fields.model,
    ok: true,
  };
}

function sanitizeFailureEvent(fields: LifecycleSanitizeFields): AgentLifecycleEvent | null {
  const failureCode = sanitizeStableCode(fields.raw.failureCode);
  if (!failureCode) return null;
  const failureDomain = sanitizeStableCode(fields.raw.failureDomain);
  const errorKind = sanitizeStableCode(fields.raw.errorKind);
  return {
    kind: "failure",
    role: fields.role,
    ...(fields.phase ? { phase: fields.phase } : {}),
    ...(fields.checkpointId ? { checkpointId: fields.checkpointId } : {}),
    provider: fields.provider,
    model: fields.model,
    ok: false,
    failureCode,
    ...(failureDomain ? { failureDomain } : {}),
    ...(errorKind ? { errorKind } : {}),
  };
}

function sanitizeLifecycleEventByKind(
  kind: AgentLifecycleEvent["kind"],
  fields: LifecycleSanitizeFields,
): AgentLifecycleEvent | null {
  switch (kind) {
    case "turn":
      return sanitizeTurnEvent(fields);
    case "tool":
      return sanitizeToolEvent(fields);
    case "retry":
      return sanitizeRetryEvent(fields);
    case "compaction":
      return sanitizeCompactionEvent(fields);
    case "usage":
      return sanitizeUsageEvent(fields);
    case "cancellation":
      return sanitizeCancellationEvent(fields);
    case "completion":
      return sanitizeCompletionEvent(fields);
    case "failure":
      return sanitizeFailureEvent(fields);
    default: {
      const _exhaustive: never = kind;
      logWarn("agent_lifecycle_unexpected_kind", { kind: String(_exhaustive) });
      return null;
    }
  }
}

/**
 * Allowlist + redact Agent lifecycle events before they leave the Pi session seam.
 * Returns null when the event cannot be represented safely.
 */
export function sanitizeAgentLifecycleEvent(raw: unknown): AgentLifecycleEvent | null {
  if (!isPlainObject(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEY_RE.test(key)) return null;
  }

  const kind = asString(raw.kind);
  if (!kind || !isAgentLifecycleEventKind(kind)) return null;

  const role = asString(raw.role);
  if (!role || !SESSION_ROLES.has(role as AgentSessionRole)) return null;

  const provider = asString(raw.provider);
  const model = asString(raw.model);
  if (!provider || !model) return null;

  const phaseRaw = asString(raw.phase);
  const phase =
    phaseRaw && SESSION_PHASES.has(phaseRaw as AgentSessionPhase)
      ? (phaseRaw as AgentSessionPhase)
      : undefined;

  return sanitizeLifecycleEventByKind(kind, {
    role: role as AgentSessionRole,
    provider,
    model,
    phase,
    checkpointId: asString(raw.checkpointId),
    raw,
  });
}

export function createSanitizedEventSink(
  sink: (event: AgentLifecycleEvent) => void,
): (raw: unknown) => void {
  return (raw) => {
    const sanitized = sanitizeAgentLifecycleEvent(raw);
    if (sanitized) sink(sanitized);
  };
}
