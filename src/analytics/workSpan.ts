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
};

export type WorkSpanKind = "llm_generation" | "publish_span" | "phase_checkpoint";

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
};

export type LlmWorkSpan = WorkSpanBase & {
  readonly kind: "llm_generation";
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
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

export type WorkSpan = LlmWorkSpan | PublishWorkSpan | CheckpointWorkSpan;

export function newSpanId(): string {
  return randomUUID();
}

function sharedPostHogProperties(span: WorkSpan): Record<string, string | number | boolean | null> {
  return {
    $ai_trace_id: span.workItemId,
    $ai_span_id: span.spanId,
    $ai_span_name: span.spanName,
    $ai_parent_id: span.parentSpanId,
    $ai_latency: span.latencyMs / 1000,
    $ai_is_error: span.isError,
    $ai_session_id: null,
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
          $ai_input_tokens: span.inputTokens,
          $ai_output_tokens: span.outputTokens,
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
          inputTokens: span.inputTokens,
          outputTokens: span.outputTokens,
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
    default: {
      const exhaustive: never = span;
      return exhaustive;
    }
  }
}

export function captureWorkSpan(span: WorkSpan): void {
  const projected = projectWorkSpanToPostHog(span);
  captureEvent({
    distinctId: installationDistinctId(span.installationId),
    event: projected.event,
    properties: projected.properties,
  });
}

export function llmSpanFromSession(input: {
  readonly context: WorkSpanContext;
  readonly phase: string;
  readonly sessionRole?: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly isError: boolean;
  readonly errorReason?: string;
}): LlmWorkSpan {
  return {
    kind: "llm_generation",
    workItemId: input.context.workItemId,
    installationId: input.context.installationId,
    owner: input.context.owner,
    repo: input.context.repo,
    prNumber: input.context.prNumber,
    spanId: newSpanId(),
    spanName: input.sessionRole != null ? `${input.sessionRole}:${input.phase}` : input.phase,
    parentSpanId: null,
    latencyMs: input.latencyMs,
    isError: input.isError,
    ...(input.errorReason != null ? { errorReason: input.errorReason } : {}),
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    phase: input.phase,
    ...(input.sessionRole != null ? { sessionRole: input.sessionRole } : {}),
  };
}

export function publishSpanFromContext(input: {
  readonly context: WorkSpanContext;
  readonly publishStep: string;
  readonly latencyMs: number;
  readonly isError: boolean;
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
    parentSpanId: null,
    latencyMs: input.latencyMs,
    isError: input.isError,
    ...(input.errorReason != null ? { errorReason: input.errorReason } : {}),
    publishStep: input.publishStep,
  };
}
