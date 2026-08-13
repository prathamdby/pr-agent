import * as v from "valibot";
import { logWarn } from "../../evlog.js";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.js";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  jsonValueSchema,
  type JsonValue,
} from "../../util/jsonValue.js";
import { isAgentLifecycleEventKind, type AgentLifecycleEvent } from "./lifecycleEvents.js";
import type { AgentSessionPhase, AgentSessionRole } from "./types.js";

type ToolEventDraft = {
  kind: "tool";
  role: AgentSessionRole;
  phase?: AgentSessionPhase;
  checkpointId?: string;
  toolName: string;
  ok?: boolean;
  provider: string;
  model: string;
};

type RetryEventDraft = {
  kind: "retry";
  role: AgentSessionRole;
  checkpointId?: string;
  provider: string;
  model: string;
  attempt?: number;
  reason: string;
};

type UsageEventDraft = {
  kind: "usage";
  role: AgentSessionRole;
  phase?: AgentSessionPhase;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type CompletionEventDraft = {
  kind: "completion";
  role: AgentSessionRole;
  phase?: AgentSessionPhase;
  checkpointId?: string;
  provider: string;
  model: string;
  ok: true;
};

type FailureEventDraft = {
  kind: "failure";
  role: AgentSessionRole;
  phase?: AgentSessionPhase;
  checkpointId?: string;
  provider: string;
  model: string;
  ok: false;
  failureCode: string;
  failureDomain?: string;
  errorKind?: string;
};

const sessionRoleSchema = v.picklist([
  "orchestrator",
  "specialist",
  "ask",
  "description",
  "triage",
  "verification",
  "ci_summary",
]);

const sessionPhaseSchema = v.picklist([
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

function asString(value: JsonValue): string | undefined {
  return isJsonString(value) && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: JsonValue): number | undefined {
  return isJsonNumber(value) && Number.isFinite(value) ? value : undefined;
}

function sanitizeStableCode(value: JsonValue): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  // Stable codes are dotted identifiers — reject free-form exception text.
  if (!/^[a-z][a-z0-9_.]{0,127}$/i.test(raw)) return undefined;
  return raw;
}

function sanitizeToolName(value: JsonValue): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/.test(raw)) return undefined;
  return raw;
}

function sanitizeReason(value: JsonValue): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const cleaned = sanitizeLogMessage(raw);
  if (!cleaned) return undefined;
  // Reject long free-form blobs that look like model/repo content.
  if (cleaned.length > 64) return cleaned.slice(0, 64);
  return cleaned;
}

function fieldOrNull(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}

/**
 * Allowlist + redact Agent lifecycle events before they leave the Pi session seam.
 * Returns null when the event cannot be represented safely.
 */
export function sanitizeAgentLifecycleEvent(raw: JsonValue): AgentLifecycleEvent | null {
  if (!isJsonObject(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEY_RE.test(key)) return null;
  }

  const kind = asString(fieldOrNull(raw.kind));
  if (!kind || !isAgentLifecycleEventKind(kind)) return null;

  const roleRaw = asString(fieldOrNull(raw.role));
  if (!roleRaw || !v.is(sessionRoleSchema, roleRaw)) return null;
  const role: AgentSessionRole = roleRaw;

  const provider = asString(fieldOrNull(raw.provider));
  const model = asString(fieldOrNull(raw.model));
  if (!provider || !model) return null;

  const phaseRaw = asString(fieldOrNull(raw.phase));
  const phase: AgentSessionPhase | undefined =
    phaseRaw && v.is(sessionPhaseSchema, phaseRaw) ? phaseRaw : undefined;
  const checkpointId = asString(fieldOrNull(raw.checkpointId));

  switch (kind) {
    case "turn": {
      if (!phase || !checkpointId) return null;
      return { kind, role, phase, checkpointId, provider, model };
    }
    case "tool": {
      const toolName = sanitizeToolName(fieldOrNull(raw.toolName));
      if (!toolName) return null;
      const event: ToolEventDraft = { kind, role, toolName, provider, model };
      if (phase) event.phase = phase;
      if (checkpointId) event.checkpointId = checkpointId;
      const okRaw = raw.ok;
      if (okRaw !== undefined && isJsonBoolean(okRaw)) event.ok = okRaw;
      return event;
    }
    case "retry": {
      const reason = sanitizeReason(fieldOrNull(raw.reason));
      if (!reason) return null;
      const event: RetryEventDraft = { kind, role, provider, model, reason };
      if (checkpointId) event.checkpointId = checkpointId;
      const attempt = asFiniteNumber(fieldOrNull(raw.attempt));
      if (attempt !== undefined) event.attempt = attempt;
      return event;
    }
    case "compaction": {
      const reason = sanitizeReason(fieldOrNull(raw.reason));
      if (!reason) return null;
      return { kind, role, provider, model, reason };
    }
    case "usage": {
      const event: UsageEventDraft = { kind, role, provider, model };
      if (phase) event.phase = phase;
      const inputTokens = asFiniteNumber(fieldOrNull(raw.inputTokens));
      if (inputTokens !== undefined) event.inputTokens = inputTokens;
      const outputTokens = asFiniteNumber(fieldOrNull(raw.outputTokens));
      if (outputTokens !== undefined) event.outputTokens = outputTokens;
      const totalTokens = asFiniteNumber(fieldOrNull(raw.totalTokens));
      if (totalTokens !== undefined) event.totalTokens = totalTokens;
      return event;
    }
    case "cancellation": {
      const reason = sanitizeReason(fieldOrNull(raw.reason)) ?? "abort";
      return { kind, role, provider, model, reason };
    }
    case "completion": {
      const event: CompletionEventDraft = { kind, role, provider, model, ok: true };
      if (phase) event.phase = phase;
      if (checkpointId) event.checkpointId = checkpointId;
      return event;
    }
    case "failure": {
      const failureCode = sanitizeStableCode(fieldOrNull(raw.failureCode));
      if (!failureCode) return null;
      const event: FailureEventDraft = { kind, role, provider, model, ok: false, failureCode };
      if (phase) event.phase = phase;
      if (checkpointId) event.checkpointId = checkpointId;
      const failureDomain = sanitizeStableCode(fieldOrNull(raw.failureDomain));
      if (failureDomain) event.failureDomain = failureDomain;
      const errorKind = sanitizeStableCode(fieldOrNull(raw.errorKind));
      if (errorKind) event.errorKind = errorKind;
      return event;
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
): (raw: JsonValue) => void {
  return (raw) => {
    const parsed = v.safeParse(jsonValueSchema, raw);
    if (!parsed.success) return;
    const sanitized = sanitizeAgentLifecycleEvent(parsed.output);
    if (sanitized) sink(sanitized);
  };
}
