import type { Pool, PoolClient } from "pg";
import type { Config } from "../../settings/index.js";
import {
  llmSpanFromSession,
  publishSpanFromContext,
  projectWorkSpanToAgentEventRow,
  type WorkSpan,
} from "../../analytics/workSpan.js";
import { recordExecutionSpan } from "../../traces/recorder.js";
import type { AgentEventInsertRow } from "../../agentWork/agentEventsRepository.js";
import { safeAppendAgentEvents } from "../../agentWork/agentEventsRepository.js";
import type { TurnEnd } from "../providers/usageMetadata.js";
import type { AgentAuditRecord } from "./agentAudit.js";
import { agentAuditRecordFromLifecycleEvent } from "./agentAudit.js";
import type { AgentLifecycleEvent } from "./lifecycleEvents.js";
import type { AgentSessionRole } from "./types.js";
import type { FindingSource } from "../../review/orchestrator/orchestratorTypes.js";

export type AgentEventsContext = {
  readonly pool: Pool | PoolClient;
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly executionId?: string;
  readonly attemptCount?: number;
};

function baseInsertRow(context: AgentEventsContext): Omit<AgentEventInsertRow, "eventKind"> {
  return {
    workItemId: context.workItemId,
    installationId: context.installationId,
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
  };
}

export function lifecycleAuditToInsertRow(
  context: AgentEventsContext,
  record: AgentAuditRecord,
  sessionRole?: AgentSessionRole,
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {};
  if (record.sessionId != null) detail.sessionId = record.sessionId;
  if (record.generationId != null) detail.generationId = record.generationId;
  if (record.specialistId != null) detail.specialistId = record.specialistId;
  if (context.executionId != null) detail.executionId = context.executionId;
  if (context.attemptCount != null) detail.attemptCount = context.attemptCount;
  if (record.attempt != null) detail.attempt = record.attempt;
  if (record.reason != null) detail.reason = record.reason;
  if (record.failureDomain != null) detail.failureDomain = record.failureDomain;
  if (record.errorKind != null) detail.errorKind = record.errorKind;
  if (record.outcome != null) detail.outcome = record.outcome;
  if (record.end != null) detail.end = record.end;
  if (record.durationMs != null) detail.durationMs = record.durationMs;
  if (record.inputTokens != null) detail.inputTokens = record.inputTokens;
  if (record.outputTokens != null) detail.outputTokens = record.outputTokens;
  if (record.cacheReadTokens != null) detail.cacheReadTokens = record.cacheReadTokens;
  if (record.cacheWriteTokens != null) detail.cacheWriteTokens = record.cacheWriteTokens;
  if (record.cacheWrite1hTokens != null) detail.cacheWrite1hTokens = record.cacheWrite1hTokens;
  if (record.totalTokens != null) detail.totalTokens = record.totalTokens;
  if (record.admittedHostCalls != null) detail.admittedHostCalls = record.admittedHostCalls;
  if (record.completedHostCalls != null) detail.completedHostCalls = record.completedHostCalls;
  if (record.transferredBytes != null) detail.transferredBytes = record.transferredBytes;
  if (record.outputBytes != null) detail.outputBytes = record.outputBytes;
  if (record.failureCode != null && record.kind === "execution") {
    detail.errorCode = record.failureCode;
  }

  return {
    ...baseInsertRow(context),
    sessionRole: sessionRole ?? record.role,
    eventKind: record.kind,
    phase: record.phase ?? null,
    checkpointId: record.checkpointId ?? null,
    toolName: record.toolName ?? null,
    provider: record.provider,
    model: record.model,
    ok: record.ok ?? null,
    failureCode: record.failureCode ?? null,
    detail,
  };
}

export function decisionEventRow(
  context: AgentEventsContext,
  params: {
    readonly sessionRole?: AgentSessionRole;
    readonly phase?: string;
    readonly specialist: FindingSource;
    readonly submittedCount: number;
    readonly acceptedCount: number;
    readonly rejectedCount: number;
    readonly degradedReason?: "judgment_failed" | "judgment_unpublished" | "judgment_unavailable";
    readonly turnEnd?: TurnEnd;
  },
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    specialist: params.specialist,
    submittedCount: params.submittedCount,
    acceptedCount: params.acceptedCount,
    rejectedCount: params.rejectedCount,
  };
  if (params.degradedReason != null) detail.degradedReason = params.degradedReason;
  if (params.turnEnd != null) detail.turnEnd = params.turnEnd;

  return {
    ...baseInsertRow(context),
    sessionRole: params.sessionRole ?? "orchestrator",
    eventKind: "decision",
    phase: params.phase ?? "judgment",
    detail,
  };
}

export function publishEventRow(
  context: AgentEventsContext,
  params: {
    readonly sessionRole?: AgentSessionRole;
    readonly phase?: string;
    readonly specialist: FindingSource;
    readonly batchId: string;
    readonly postedCount: number;
    readonly suppressedCount?: number;
    readonly capDowngraded?: number;
    readonly anchorDropped?: number;
  },
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    specialist: params.specialist,
    batchId: params.batchId,
    postedCount: params.postedCount,
  };
  if (params.suppressedCount != null) detail.suppressedCount = params.suppressedCount;
  if (params.capDowngraded != null) detail.capDowngraded = params.capDowngraded;
  if (params.anchorDropped != null) detail.anchorDropped = params.anchorDropped;

  return {
    ...baseInsertRow(context),
    sessionRole: params.sessionRole ?? "orchestrator",
    eventKind: "publish",
    phase: params.phase ?? "judgment",
    detail,
  };
}

export function checkoutCoverageEventRow(
  context: AgentEventsContext,
  params: {
    readonly sessionRole?: AgentSessionRole;
    readonly phase?: string;
    readonly coverageMode: "full" | "sparse";
    readonly pathsInCheckout: number;
    readonly truncated: boolean;
  },
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    coverageMode: params.coverageMode,
    pathsInCheckout: params.pathsInCheckout,
    truncated: params.truncated,
  };

  return {
    ...baseInsertRow(context),
    sessionRole: params.sessionRole ?? "review",
    eventKind: "coverage",
    phase: params.phase ?? "prepare",
    detail,
  };
}

export function evidenceRejectEventRow(
  context: AgentEventsContext,
  params: {
    readonly sessionRole?: AgentSessionRole;
    readonly phase?: string;
    readonly specialist?: FindingSource;
    readonly rejectedCount: number;
    readonly reasonCode: string;
  },
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    rejectedCount: params.rejectedCount,
    reasonCode: params.reasonCode,
  };
  if (params.specialist != null) detail.specialist = params.specialist;

  return {
    ...baseInsertRow(context),
    sessionRole: params.sessionRole ?? "orchestrator",
    eventKind: "evidence_reject",
    phase: params.phase ?? null,
    detail,
  };
}

export function createDurableLifecycleEventSink(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEvents">,
): (event: AgentLifecycleEvent) => void {
  return (event) => {
    const record = agentAuditRecordFromLifecycleEvent(event);
    const row = lifecycleAuditToInsertRow(context, record, event.role);
    safeEmitAgentEvent(context, cfg, row);
    if (event.kind !== "completion" && event.kind !== "failure") return;
    if (event.phase == null) return;
    if (event.durationMs == null) return;
    emitWorkSpan(
      context,
      cfg,
      llmSpanFromSession({
        traceSpanId: event.traceSpanId,
        context,
        phase: event.phase,
        sessionRole: event.role,
        provider: event.provider,
        model: event.model,
        ...(event.generationId != null ? { spanId: event.generationId } : {}),
        ...(event.sessionId != null ? { sessionId: event.sessionId } : {}),
        ...(event.specialistId != null ? { specialistId: event.specialistId } : {}),
        latencyMs: event.durationMs,
        isError: event.kind === "failure",
        ...(event.inputTokens != null ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens != null ? { outputTokens: event.outputTokens } : {}),
        ...(event.cacheReadTokens != null ? { cacheReadTokens: event.cacheReadTokens } : {}),
        ...(event.cacheWriteTokens != null ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
        ...(event.cacheWrite1hTokens != null
          ? { cacheWrite1hTokens: event.cacheWrite1hTokens }
          : {}),
        ...(event.totalTokens != null ? { totalTokens: event.totalTokens } : {}),
        ...(event.kind === "failure" ? { errorReason: event.failureCode } : {}),
      }),
    );
  };
}

function recordNonGenerationSpan(span: WorkSpan): void {
  if (span.kind === "llm_generation") return;
  const extra: Record<string, string | number | boolean | null> = {};
  if (span.kind === "publish_span") extra.publish_step = span.publishStep;
  if (span.kind === "specialist_span") {
    extra.stage = span.stage;
    extra.outcome = span.outcome;
    if (span.submittedCount != null) extra.submitted_count = span.submittedCount;
    if (span.acceptedCount != null) extra.accepted_count = span.acceptedCount;
    if (span.rejectedCount != null) extra.rejected_count = span.rejectedCount;
  }
  if (span.attemptCount != null) extra.attempt_count = span.attemptCount;
  recordExecutionSpan({
    event: "$ai_span",
    spanId: span.spanId,
    spanName: span.spanName,
    status: span.isError ? "error" : "ok",
    latencyMs: span.latencyMs,
    ...(span.isError ? { isError: true, error: span.errorReason ?? span.kind } : {}),
    ...("phase" in span ? { phase: span.phase } : {}),
    ...(span.specialistId != null ? { specialist: span.specialistId } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });
}

export function emitWorkSpan(
  context: AgentEventsContext | null,
  cfg: Pick<Config, "agentEvents">,
  span: WorkSpan,
): void {
  recordNonGenerationSpan(span);
  if (!context) return;
  safeEmitAgentEvent(context, cfg, projectWorkSpanToAgentEventRow(context, span));
}

export function safeEmitAgentEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEvents">,
  row: AgentEventInsertRow,
): void {
  try {
    safeAppendAgentEvents(context.pool, cfg, [row]);
  } catch {
    // Optional audit persistence must not alter feature execution or analytics.
  }
}

export function safeEmitDecisionEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEvents">,
  params: Parameters<typeof decisionEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, decisionEventRow(context, params));
}

export function safeEmitPublishEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEvents">,
  params: Parameters<typeof publishEventRow>[1] & {
    readonly latencyMs: number;
    readonly parentSpanId?: string | null;
  },
): void {
  const span = publishSpanFromContext({
    context,
    publishStep: params.batchId,
    latencyMs: params.latencyMs,
    isError: false,
    ...(params.parentSpanId !== undefined ? { parentSpanId: params.parentSpanId } : {}),
  });
  const row = publishEventRow(context, params);
  safeEmitAgentEvent(context, cfg, {
    ...row,
    detail: {
      ...row.detail,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      latencyMs: span.latencyMs,
    },
  });
  recordNonGenerationSpan(span);
}

export function safeEmitCoverageEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEvents">,
  params: Parameters<typeof checkoutCoverageEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, checkoutCoverageEventRow(context, params));
}

export function safeEmitEvidenceRejectEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEvents">,
  params: Parameters<typeof evidenceRejectEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, evidenceRejectEventRow(context, params));
}

export function resolveAgentEventsContext(
  _cfg: Pick<Config, "agentEvents">,
  sessionContext?: {
    readonly pool: Pool | PoolClient;
    readonly workItemId: string;
    readonly installationId: number;
    readonly owner?: string;
    readonly repo?: string;
    readonly prNumber?: number;
    readonly executionId?: string;
    readonly attemptCount?: number;
  },
): AgentEventsContext | null {
  if (!sessionContext) return null;
  const { owner, repo, prNumber } = sessionContext;
  if (!owner || !repo || prNumber == null) return null;
  return {
    pool: sessionContext.pool,
    workItemId: sessionContext.workItemId,
    installationId: sessionContext.installationId,
    owner,
    repo,
    prNumber,
    ...(sessionContext.executionId != null ? { executionId: sessionContext.executionId } : {}),
    ...(sessionContext.attemptCount != null ? { attemptCount: sessionContext.attemptCount } : {}),
  };
}
