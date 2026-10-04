import { randomUUID } from "node:crypto";
import { captureEvent } from "./index.js";
import type { AgentEventInsertRow } from "../agentWork/agentEventsRepository.js";
import { installationDistinctId } from "./workCompleted.js";

export type WorkSpanContext = {
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly executionId?: string;
  readonly attemptCount?: number;
};

export type WorkSpanKind =
  | "llm_generation"
  | "publish_span"
  | "phase_checkpoint"
  | "specialist_span";

type WorkSpanBase = {
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly spanId: string;
  readonly spanName: string;
  readonly parentSpanId: string | null;
  readonly latencyMs: number;
  readonly isError: boolean;
  readonly errorReason?: string;
  readonly sessionId?: string;
  readonly specialistId?: string;
  readonly executionId?: string;
  readonly attemptCount?: number;
};

export type LlmWorkSpan = WorkSpanBase & {
  readonly kind: "llm_generation";
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly totalTokens?: number;
  readonly phase: string;
  readonly sessionRole?: string;
};

export type PublishWorkSpan = WorkSpanBase & {
  readonly kind: "publish_span";
  readonly publishStep: string;
};

export type CheckpointWorkSpan = WorkSpanBase & {
  readonly kind: "phase_checkpoint";
  readonly phase: string;
};

export type SpecialistWorkSpan = WorkSpanBase & {
  readonly kind: "specialist_span";
  readonly phase: "specialist";
  readonly specialistId: string;
  readonly stage: "schema" | "validation" | "run";
  readonly outcome: "accepted" | "rejected" | "report" | "empty" | "error";
  readonly submittedCount?: number;
  readonly acceptedCount?: number;
  readonly rejectedCount?: number;
};

export type WorkSpan = LlmWorkSpan | PublishWorkSpan | CheckpointWorkSpan | SpecialistWorkSpan;

export function newSpanId(): string {
  return randomUUID();
}

function sharedPostHogProperties(span: WorkSpan): Record<string, string | number | boolean | null> {
  return {
    $ai_trace_id: span.workItemId,
    $ai_span_id: span.spanId,
    $ai_span_name: span.spanName,
    ...(span.parentSpanId != null ? { $ai_parent_id: span.parentSpanId } : {}),
    $ai_latency: span.latencyMs / 1000,
    $ai_is_error: span.isError,
    ...(span.sessionId != null ? { $ai_session_id: span.sessionId } : {}),
    ...(span.specialistId != null ? { specialist_id: span.specialistId } : {}),
    ...(span.executionId != null ? { execution_id: span.executionId } : {}),
    ...(span.attemptCount != null ? { attempt_count: span.attemptCount } : {}),
    work_item_id: span.workItemId,
    owner: span.owner,
    repo: span.repo,
    pr_number: span.prNumber,
    ...(span.errorReason != null ? { $ai_error: span.errorReason } : {}),
  };
}

export function projectWorkSpanToPostHog(span: WorkSpan): {
  readonly event: "$ai_generation" | "$ai_span";
  readonly properties: Record<string, string | number | boolean | null>;
} {
  const shared = sharedPostHogProperties(span);
  switch (span.kind) {
    case "llm_generation":
      return {
        event: "$ai_generation",
        properties: {
          ...shared,
          $ai_model: span.model,
          $ai_provider: span.provider,
          ...(span.inputTokens != null ? { $ai_input_tokens: span.inputTokens } : {}),
          ...(span.outputTokens != null ? { $ai_output_tokens: span.outputTokens } : {}),
          ...(span.cacheReadTokens != null ? { $ai_cache_read_tokens: span.cacheReadTokens } : {}),
          ...(span.cacheWriteTokens != null
            ? { $ai_cache_write_tokens: span.cacheWriteTokens }
            : {}),
          ...(span.cacheWrite1hTokens != null
            ? { $ai_cache_write_1h_tokens: span.cacheWrite1hTokens }
            : {}),
          ...(span.totalTokens != null ? { $ai_total_tokens: span.totalTokens } : {}),
          phase: span.phase,
          ...(span.sessionRole != null ? { session_role: span.sessionRole } : {}),
        },
      };
    case "publish_span":
      return {
        event: "$ai_span",
        properties: {
          ...shared,
          publish_step: span.publishStep,
        },
      };
    case "phase_checkpoint":
      return {
        event: "$ai_span",
        properties: {
          ...shared,
          phase: span.phase,
        },
      };
    case "specialist_span":
      return {
        event: "$ai_span",
        properties: {
          ...shared,
          phase: span.phase,
          stage: span.stage,
          outcome: span.outcome,
          ...(span.submittedCount != null ? { submitted_count: span.submittedCount } : {}),
          ...(span.acceptedCount != null ? { accepted_count: span.acceptedCount } : {}),
          ...(span.rejectedCount != null ? { rejected_count: span.rejectedCount } : {}),
        },
      };
    default: {
      const exhaustive: never = span;
      return exhaustive;
    }
  }
}

export function projectWorkSpanToAgentEventRow(
  context: WorkSpanContext,
  span: WorkSpan,
): AgentEventInsertRow {
  const detail: Record<string, unknown> = {
    spanId: span.spanId,
    spanName: span.spanName,
    latencyMs: span.latencyMs,
    isError: span.isError,
  };
  if (span.parentSpanId != null) detail.parentSpanId = span.parentSpanId;
  if (span.errorReason != null) detail.errorReason = span.errorReason;
  if (span.sessionId != null) detail.sessionId = span.sessionId;
  if (span.specialistId != null) detail.specialistId = span.specialistId;
  if (span.executionId != null) detail.executionId = span.executionId;
  if (span.attemptCount != null) detail.attemptCount = span.attemptCount;

  switch (span.kind) {
    case "llm_generation":
      return {
        workItemId: context.workItemId,
        installationId: context.installationId,
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        sessionRole: span.sessionRole ?? null,
        eventKind: "generation",
        phase: span.phase,
        provider: span.provider,
        model: span.model,
        ok: !span.isError,
        failureCode: span.errorReason ?? null,
        detail: {
          ...detail,
          ...(span.inputTokens != null ? { inputTokens: span.inputTokens } : {}),
          ...(span.outputTokens != null ? { outputTokens: span.outputTokens } : {}),
          ...(span.cacheReadTokens != null ? { cacheReadTokens: span.cacheReadTokens } : {}),
          ...(span.cacheWriteTokens != null ? { cacheWriteTokens: span.cacheWriteTokens } : {}),
          ...(span.cacheWrite1hTokens != null
            ? { cacheWrite1hTokens: span.cacheWrite1hTokens }
            : {}),
          ...(span.totalTokens != null ? { totalTokens: span.totalTokens } : {}),
        },
      };
    case "publish_span":
      return {
        workItemId: context.workItemId,
        installationId: context.installationId,
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        sessionRole: "orchestrator",
        eventKind: "publish",
        phase: "publish",
        ok: !span.isError,
        failureCode: span.errorReason ?? null,
        detail: { ...detail, publishStep: span.publishStep },
      };
    case "phase_checkpoint":
      return {
        workItemId: context.workItemId,
        installationId: context.installationId,
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        eventKind: "checkpoint",
        phase: span.phase,
        ok: !span.isError,
        failureCode: span.errorReason ?? null,
        detail,
      };
    case "specialist_span":
      return {
        workItemId: context.workItemId,
        installationId: context.installationId,
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        sessionRole: "specialist",
        eventKind: "specialist",
        phase: span.phase,
        ok: !span.isError,
        failureCode: span.errorReason ?? null,
        detail: {
          ...detail,
          stage: span.stage,
          outcome: span.outcome,
          ...(span.submittedCount != null ? { submittedCount: span.submittedCount } : {}),
          ...(span.acceptedCount != null ? { acceptedCount: span.acceptedCount } : {}),
          ...(span.rejectedCount != null ? { rejectedCount: span.rejectedCount } : {}),
        },
      };
    default: {
      const exhaustive: never = span;
      return exhaustive;
    }
  }
}

export function captureWorkSpan(span: WorkSpan): void {
  try {
    const projected = projectWorkSpanToPostHog(span);
    captureEvent({
      distinctId: installationDistinctId(span.installationId),
      event: projected.event,
      properties: projected.properties,
    });
  } catch {
    // Observability cannot fail or retry feature work.
  }
}

export function llmSpanFromSession(input: {
  readonly context: WorkSpanContext;
  readonly phase: string;
  readonly sessionRole?: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly totalTokens?: number;
  readonly latencyMs: number;
  readonly isError: boolean;
  readonly parentSpanId?: string | null;
  readonly errorReason?: string;
  readonly spanId?: string;
  readonly sessionId?: string;
  readonly specialistId?: string;
}): LlmWorkSpan {
  return {
    kind: "llm_generation",
    workItemId: input.context.workItemId,
    installationId: input.context.installationId,
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber,
    spanId: input.spanId ?? newSpanId(),
    spanName: input.sessionRole != null ? `${input.sessionRole}:${input.phase}` : input.phase,
    parentSpanId: input.parentSpanId === undefined ? input.context.workItemId : input.parentSpanId,
    latencyMs: input.latencyMs,
    isError: input.isError,
    ...(input.errorReason != null ? { errorReason: input.errorReason } : {}),
    provider: input.provider,
    model: input.model,
    ...(input.inputTokens != null ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens != null ? { outputTokens: input.outputTokens } : {}),
    ...(input.cacheReadTokens != null ? { cacheReadTokens: input.cacheReadTokens } : {}),
    ...(input.cacheWriteTokens != null ? { cacheWriteTokens: input.cacheWriteTokens } : {}),
    ...(input.cacheWrite1hTokens != null ? { cacheWrite1hTokens: input.cacheWrite1hTokens } : {}),
    ...(input.totalTokens != null ? { totalTokens: input.totalTokens } : {}),
    phase: input.phase,
    ...(input.sessionRole != null ? { sessionRole: input.sessionRole } : {}),
    ...(input.sessionId != null ? { sessionId: input.sessionId } : {}),
    ...(input.specialistId != null ? { specialistId: input.specialistId } : {}),
    ...(input.context.executionId != null ? { executionId: input.context.executionId } : {}),
    ...(input.context.attemptCount != null ? { attemptCount: input.context.attemptCount } : {}),
  };
}

export function specialistSpanFromContext(input: {
  readonly context: WorkSpanContext;
  readonly specialistId: string;
  readonly stage: SpecialistWorkSpan["stage"];
  readonly outcome: SpecialistWorkSpan["outcome"];
  readonly latencyMs: number;
  readonly errorReason?: string;
  readonly submittedCount?: number;
  readonly acceptedCount?: number;
  readonly rejectedCount?: number;
}): SpecialistWorkSpan {
  return {
    workItemId: input.context.workItemId,
    installationId: input.context.installationId,
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber,
    ...(input.context.executionId != null ? { executionId: input.context.executionId } : {}),
    ...(input.context.attemptCount != null ? { attemptCount: input.context.attemptCount } : {}),
    kind: "specialist_span",
    spanId: newSpanId(),
    spanName: `specialist:${input.specialistId}:${input.stage}`,
    parentSpanId: input.context.workItemId,
    phase: "specialist",
    specialistId: input.specialistId,
    stage: input.stage,
    outcome: input.outcome,
    latencyMs: input.latencyMs,
    isError: input.outcome === "error" || input.outcome === "rejected",
    ...(input.errorReason != null ? { errorReason: input.errorReason } : {}),
    ...(input.submittedCount != null ? { submittedCount: input.submittedCount } : {}),
    ...(input.acceptedCount != null ? { acceptedCount: input.acceptedCount } : {}),
    ...(input.rejectedCount != null ? { rejectedCount: input.rejectedCount } : {}),
  };
}

export function publishSpanFromContext(input: {
  readonly context: WorkSpanContext;
  readonly publishStep: string;
  readonly latencyMs: number;
  readonly isError: boolean;
  readonly parentSpanId?: string | null;
  readonly errorReason?: string;
}): PublishWorkSpan {
  return {
    kind: "publish_span",
    workItemId: input.context.workItemId,
    installationId: input.context.installationId,
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber,
    spanId: newSpanId(),
    spanName: `publish:${input.publishStep}`,
    parentSpanId: input.parentSpanId === undefined ? input.context.workItemId : input.parentSpanId,
    latencyMs: input.latencyMs,
    isError: input.isError,
    ...(input.errorReason != null ? { errorReason: input.errorReason } : {}),
    publishStep: input.publishStep,
    ...(input.context.executionId != null ? { executionId: input.context.executionId } : {}),
    ...(input.context.attemptCount != null ? { attemptCount: input.context.attemptCount } : {}),
  };
}
