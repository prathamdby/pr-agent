import { logWarn } from "../../evlog.ts";
import { sanitizeLogMessage } from "../../security/sanitizeLogMessage.ts";
import { isPlainObject } from "../../util/typeGuards.ts";
import type { TurnEnd } from "../providers/usageMetadata.ts";
import { isAgentLifecycleEventKind, type AgentLifecycleEvent } from "./lifecycleEvents.ts";
import type { AgentSessionPhase, AgentSessionRole } from "./types.ts";

const SESSION_ROLES = {
  orchestrator: true,
  specialist: true,
  ask: true,
  description: true,
  triage: true,
  verification: true,
  ci_summary: true,
} satisfies Record<AgentSessionRole, true>;

const SESSION_PHASES = {
  recon: true,
  specialist: true,
  judgment: true,
  synthesis: true,
  validation_repair: true,
  publish_recovery: true,
  ask: true,
  description: true,
  triage: true,
  verification: true,
  ci_summary: true,
} satisfies Record<AgentSessionPhase, true>;

const TURN_ENDS = {
  completed: true,
  output_limit: true,
  tool_budget: true,
} satisfies Record<TurnEnd, true>;

function isAgentSessionRole(value: string): value is AgentSessionRole {
  return Object.hasOwn(SESSION_ROLES, value);
}

function isAgentSessionPhase(value: string): value is AgentSessionPhase {
  return Object.hasOwn(SESSION_PHASES, value);
}

function isTurnEnd(value: string): value is TurnEnd {
  return Object.hasOwn(TURN_ENDS, value);
}

const FORBIDDEN_KEY_RE =
  /prompt|message|text|reasoning|content|argument|result|payload|token|secret|key|authorization|cookie|body|diff|patch|errorMessage|stack|cause/i;

const TOKEN_COUNT_KEYS: Record<string, true> = {
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  cacheWrite1hTokens: true,
  totalTokens: true,
};

function asString(value: unknown) {
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    typeof value === "string" && value.length > 0 ? value : undefined,
  );
}

function asFiniteNumber(value: unknown) {
  return ((pinnedReturn: number | undefined) => pinnedReturn)(
    typeof value === "number" && Number.isFinite(value) ? value : undefined,
  );
}

function sanitizeStableCode(value: unknown) {
  const raw = asString(value);
  if (!raw) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (!/^[a-z][a-z0-9_.]{0,127}$/i.test(raw))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(raw);
}

function sanitizeToolName(value: unknown) {
  const raw = asString(value);
  if (!raw) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (!/^[A-Za-z][A-Za-z0-9_./:-]{0,127}$/.test(raw))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(raw);
}

function sanitizeReason(value: unknown) {
  const raw = asString(value);
  if (!raw) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const cleaned = sanitizeLogMessage(raw);
  if (!cleaned) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (cleaned.length > 64)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(cleaned.slice(0, 64));
  return ((pinnedReturn: string | undefined) => pinnedReturn)(cleaned);
}

function tokenAndDurationFields(raw: Record<string, unknown>) {
  const durationMs = asFiniteNumber(raw.durationMs);
  const inputTokens = asFiniteNumber(raw.inputTokens);
  const outputTokens = asFiniteNumber(raw.outputTokens);
  const cacheReadTokens = asFiniteNumber(raw.cacheReadTokens);
  const cacheWriteTokens = asFiniteNumber(raw.cacheWriteTokens);
  const cacheWrite1hTokens = asFiniteNumber(raw.cacheWrite1hTokens);
  const totalTokens = asFiniteNumber(raw.totalTokens);
  return ((pinnedReturn: {
    readonly durationMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly cacheWrite1hTokens?: number;
    readonly totalTokens?: number;
  }) => pinnedReturn)({
    ...(durationMs != null ? { durationMs } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens != null ? { cacheWriteTokens } : {}),
    ...(cacheWrite1hTokens != null ? { cacheWrite1hTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
  });
}

export function sanitizeAgentLifecycleEvent(raw: unknown) {
  if (!isPlainObject(raw))
    return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(TOKEN_COUNT_KEYS, key)) continue;
    if (FORBIDDEN_KEY_RE.test(key))
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
  }

  const kind = asString(raw.kind);
  if (!kind || !isAgentLifecycleEventKind(kind))
    return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);

  const role = asString(raw.role);
  if (!role || !isAgentSessionRole(role))
    return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
  const typedRole = role;

  const provider = asString(raw.provider);
  const model = asString(raw.model);
  if (!provider || !model)
    return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);

  const phaseRaw = asString(raw.phase);
  const phase = phaseRaw && isAgentSessionPhase(phaseRaw) ? phaseRaw : undefined;
  const checkpointId = asString(raw.checkpointId);

  switch (kind) {
    case "turn": {
      if (!phase || !checkpointId)
        return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        phase,
        checkpointId,
        provider,
        model,
      });
    }
    case "tool": {
      const toolName = sanitizeToolName(raw.toolName);
      if (!toolName) return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        toolName,
        ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}),
        provider,
        model,
      });
    }
    case "retry": {
      const reason = sanitizeReason(raw.reason);
      if (!reason) return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        ...(checkpointId ? { checkpointId } : {}),
        provider,
        model,
        ...(asFiniteNumber(raw.attempt) != null ? { attempt: asFiniteNumber(raw.attempt) } : {}),
        reason,
      });
    }
    case "compaction": {
      const reason = sanitizeReason(raw.reason);
      if (!reason) return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        provider,
        model,
        reason,
      });
    }
    case "usage": {
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        provider,
        model,
        ...tokenAndDurationFields(raw),
      });
    }
    case "cancellation": {
      const reason = sanitizeReason(raw.reason) ?? "abort";
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        provider,
        model,
        reason,
      });
    }
    case "completion": {
      const end = asString(raw.end);
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        ...(phase ? { phase } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        provider,
        model,
        ok: true,
        ...(end && isTurnEnd(end) ? { end } : {}),
        ...tokenAndDurationFields(raw),
      });
    }
    case "failure": {
      const failureCode = sanitizeStableCode(raw.failureCode);
      if (!failureCode) return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
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
        ...tokenAndDurationFields(raw),
      });
    }
    case "execution": {
      const outcome = asString(raw.outcome);
      if (
        outcome !== "success" &&
        outcome !== "execution_failure" &&
        outcome !== "cancelled" &&
        outcome !== "budget"
      ) {
        return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      }
      const durationMs = asFiniteNumber(raw.durationMs);
      const admittedHostCalls = asFiniteNumber(raw.admittedHostCalls);
      const completedHostCalls = asFiniteNumber(raw.completedHostCalls);
      const transferredBytes = asFiniteNumber(raw.transferredBytes);
      const outputBytes = asFiniteNumber(raw.outputBytes);
      const terminationReason = sanitizeReason(raw.terminationReason);
      if (
        durationMs == null ||
        admittedHostCalls == null ||
        completedHostCalls == null ||
        transferredBytes == null ||
        outputBytes == null ||
        !terminationReason
      ) {
        return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
      }
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)({
        kind,
        role: typedRole,
        provider,
        model,
        outcome,
        ...(sanitizeStableCode(raw.errorCode)
          ? { errorCode: sanitizeStableCode(raw.errorCode) }
          : {}),
        durationMs,
        admittedHostCalls,
        completedHostCalls,
        transferredBytes,
        outputBytes,
        terminationReason,
      });
    }
    default: {
      const _exhaustive: never = kind;
      logWarn("agent_lifecycle_unexpected_kind", { kind: String(_exhaustive) });
      return ((pinnedReturn: AgentLifecycleEvent | null) => pinnedReturn)(null);
    }
  }
}

export function createSanitizedEventSink(sink: (event: AgentLifecycleEvent) => void) {
  return ((pinnedReturn: (raw: unknown) => void) => pinnedReturn)((raw) => {
    const sanitized = sanitizeAgentLifecycleEvent(raw);
    if (sanitized) sink(sanitized);
  });
}
