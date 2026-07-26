import type { Pool, PoolClient } from "pg";
import type { Config } from "../../config.js";
import type { AgentEventInsertRow } from "../../agentWork/agentEventsRepository.js";
import { safeAppendAgentEvents } from "../../agentWork/agentEventsRepository.js";
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
};

export type AgentExplicitEventKind = "decision" | "publish" | "coverage" | "evidence_reject";

function baseInsertRow(context: AgentEventsContext): Omit<AgentEventInsertRow, "eventKind"> {
  return {
    workItemId: context.workItemId,
    installationId: context.installationId,
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
  };
}

function metadataDetail(
  detail: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return detail;
}

/** Map a sanitized lifecycle audit record to a durable insert row. */
export function lifecycleAuditToInsertRow(
  context: AgentEventsContext,
  record: AgentAuditRecord,
  sessionRole?: AgentSessionRole,
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {};
  if (record.attempt != null) detail.attempt = record.attempt;
  if (record.reason != null) detail.reason = record.reason;
  if (record.failureDomain != null) detail.failureDomain = record.failureDomain;
  if (record.errorKind != null) detail.errorKind = record.errorKind;

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
    detail: metadataDetail(detail),
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
    readonly degraded?: boolean;
  },
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    specialist: params.specialist,
    submittedCount: params.submittedCount,
    acceptedCount: params.acceptedCount,
    rejectedCount: params.rejectedCount,
  };
  if (params.degraded === true) detail.degraded = true;

  return {
    ...baseInsertRow(context),
    sessionRole: params.sessionRole ?? "orchestrator",
    eventKind: "decision",
    phase: params.phase ?? "judgment",
    detail: metadataDetail(detail),
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
    detail: metadataDetail(detail),
  };
}

export function coverageEventRow(
  context: AgentEventsContext,
  params: {
    readonly sessionRole?: AgentSessionRole;
    readonly phase?: string;
    readonly coverageKind: "full" | "partial" | "none";
    readonly failedSpecialists?: readonly string[];
  },
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    coverageKind: params.coverageKind,
  };
  if (params.failedSpecialists != null && params.failedSpecialists.length > 0) {
    detail.failedSpecialists = params.failedSpecialists;
  }

  return {
    ...baseInsertRow(context),
    sessionRole: params.sessionRole ?? "orchestrator",
    eventKind: "coverage",
    phase: params.phase ?? "synthesis",
    detail: metadataDetail(detail),
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
    detail: metadataDetail(detail),
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
    detail: metadataDetail(detail),
  };
}

export function createDurableLifecycleEventSink(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEventsEnabled">,
): (event: AgentLifecycleEvent) => void {
  return (event) => {
    const record = agentAuditRecordFromLifecycleEvent(event);
    const row = lifecycleAuditToInsertRow(context, record, event.role);
    safeAppendAgentEvents(context.pool, cfg, [row]);
  };
}

export function safeEmitAgentEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEventsEnabled">,
  row: AgentEventInsertRow,
): void {
  safeAppendAgentEvents(context.pool, cfg, [row]);
}

export function safeEmitDecisionEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEventsEnabled">,
  params: Parameters<typeof decisionEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, decisionEventRow(context, params));
}

export function safeEmitPublishEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEventsEnabled">,
  params: Parameters<typeof publishEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, publishEventRow(context, params));
}

export function safeEmitCoverageEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEventsEnabled">,
  params: Parameters<typeof checkoutCoverageEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, checkoutCoverageEventRow(context, params));
}

export function safeEmitEvidenceRejectEvent(
  context: AgentEventsContext,
  cfg: Pick<Config, "agentEventsEnabled">,
  params: Parameters<typeof evidenceRejectEventRow>[1],
): void {
  safeEmitAgentEvent(context, cfg, evidenceRejectEventRow(context, params));
}

export function resolveAgentEventsContext(
  cfg: Pick<Config, "agentEventsEnabled">,
  durability?: {
    readonly pool: Pool | PoolClient;
    readonly workItemId: string;
    readonly installationId: number;
    readonly owner?: string;
    readonly repo?: string;
    readonly prNumber?: number;
  },
): AgentEventsContext | null {
  if (!cfg.agentEventsEnabled || !durability) return null;
  const { owner, repo, prNumber } = durability;
  if (!owner || !repo || prNumber == null) return null;
  return {
    pool: durability.pool,
    workItemId: durability.workItemId,
    installationId: durability.installationId,
    owner,
    repo,
    prNumber,
  };
}
