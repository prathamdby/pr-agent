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
  const typedRole = role as AgentSessionRole;

  const provider = asString(raw.provider);
  const model = asString(raw.model);
  if (!provider || !model) return null;

  const phaseRaw = asString(raw.phase);
  const phase =
    phaseRaw && SESSION_PHASES.has(phaseRaw as AgentSessionPhase)
      ? (phaseRaw as AgentSessionPhase)
      : undefined;
  const checkpointId = asString(raw.checkpointId);

  switch (kind) {
    case "turn": {
      if (!phase || !checkpointId) return null;
      return { kind, role: typedRole, phase, checkpointId, provider, model };
    }
    case "tool": {
      const toolName = sanitizeToolName(raw.toolName);
      if (!toolName) return null;
      return {
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        toolName,
        ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}),
        provider,
        model,
      };
    }
    case "retry": {
      const reason = sanitizeReason(raw.reason);
      if (!reason) return null;
      return {
        kind,
        role: typedRole,
        ...(checkpointId ? { checkpointId } : {}),
        provider,
        model,
        ...(asFiniteNumber(raw.attempt) != null ? { attempt: asFiniteNumber(raw.attempt) } : {}),
        reason,
      };
    }
    case "compaction": {
      const reason = sanitizeReason(raw.reason);
      if (!reason) return null;
      return { kind, role: typedRole, provider, model, reason };
    }
    case "usage": {
      return {
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        provider,
        model,
        ...(asFiniteNumber(raw.inputTokens) != null
          ? { inputTokens: asFiniteNumber(raw.inputTokens) }
          : {}),
        ...(asFiniteNumber(raw.outputTokens) != null
          ? { outputTokens: asFiniteNumber(raw.outputTokens) }
          : {}),
        ...(asFiniteNumber(raw.totalTokens) != null
          ? { totalTokens: asFiniteNumber(raw.totalTokens) }
          : {}),
      };
    }
    case "cancellation": {
      const reason = sanitizeReason(raw.reason) ?? "abort";
      return { kind, role: typedRole, provider, model, reason };
    }
    case "completion": {
      return {
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        provider,
        model,
        ok: true,
      };
    }
    case "failure": {
      const failureCode = sanitizeStableCode(raw.failureCode);
      if (!failureCode) return null;
      return {
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        provider,
        model,
        ok: false,
        failureCode,
        ...(sanitizeStableCode(raw.failureDomain)
          ? { failureDomain: sanitizeStableCode(raw.failureDomain) }
          : {}),
        ...(sanitizeStableCode(raw.errorKind)
          ? { errorKind: sanitizeStableCode(raw.errorKind) }
          : {}),
      };
    }
    default: {
      const _exhaustive: never = kind;
      logWarn("agent_lifecycle_unexpected_kind", { kind: String(_exhaustive) });
      return null;
    }
  }
}

export function createSanitizedEventSink(
  sink: (event: AgentLifecycleEvent) => void,
): (raw: unknown) => void {
  return (raw) => {
    const sanitized = sanitizeAgentLifecycleEvent(raw);
    if (sanitized) sink(sanitized);
  };
}
