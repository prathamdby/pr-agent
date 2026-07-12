import { logDebug } from "../../evlog.js";

/** Provider-neutral tool-call metric event. Review runs map this into review metrics. */
export type AgentToolCallMetricEvent = {
  readonly kind: "tool_call";
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  readonly resultBytes?: number;
  readonly resultCharacters?: number;
};

export type OnAgentToolCallMetric = (event: AgentToolCallMetricEvent) => void;

export function safeEmitToolCallMetric(
  onToolCallMetric: OnAgentToolCallMetric | undefined,
  event: AgentToolCallMetricEvent,
): void {
  if (!onToolCallMetric) return;
  try {
    onToolCallMetric(event);
  } catch (error) {
    logDebug("agent_tool_call_metric_failed", {
      tool: event.name,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
