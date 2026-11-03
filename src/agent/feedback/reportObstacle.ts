import type { Pool, PoolClient } from "pg";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { AgentRunnerToolExecutor, AgentToolCallContext } from "../providers/interface.ts";
import { parseToolInput } from "../tools/parseToolInput.ts";
import { toToolParameters } from "../tools/toolParams.ts";
import { insertAgentFeedback } from "../../agentWork/agentFeedbackRepository.ts";
import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import type { AgentSessionRole } from "../runtime/types.ts";

export const REPORT_OBSTACLE_NAME = "report_obstacle";

export const REPORT_OBSTACLE_DESCRIPTION = [
  "Report one obstacle that blocked or degraded this session, then continue the review.",
  "Call this when a tool, prompt, input, or instruction stopped the step you were on, returned something you could not use, or contradicted itself.",
  "Call it once for that obstacle. Do not call it for a finding, ordinary uncertainty, a style preference, or to reach another reviewer.",
  "The server stores the report with this run's identity. The result is only whether it was stored. It does not show other reports and it does not change the review.",
  "If the result is recorded false and includes error, correct that field once. If recorded is false and error is absent, continue without calling again.",
].join(" ");

const obstacleKind = v.pipe(
  v.picklist(["tool", "prompt", "input", "instruction"]),
  v.description(
    "What got in the way. tool is a tool call. prompt is system or user prompt text. input is a file, diff, or other evidence. instruction is a rule you were told to follow.",
  ),
);

const severity = v.pipe(
  v.picklist(["blocked", "degraded", "noise"]),
  v.description(
    "blocked means you cannot finish that step. degraded means you can finish it with a worse result. noise means you recovered after a wasted step.",
  ),
);

function boundedText(max: number, description: string) {
  return v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max), v.description(description));
}

export const reportObstacleSchema = v.object({
  intent: boundedText(500, "What you were trying to do. One or two concrete sentences."),
  obstacle: obstacleKind,
  subject: boundedText(
    120,
    "The tool name, the prompt section, or a short label for the input or instruction. Example: searchWorkspace.",
  ),
  problem: boundedText(800, "What went wrong. Include the error text or the contradiction."),
  expected: boundedText(500, "What you needed instead so the step could finish."),
  severity,
});

export type ReportObstacle = v.InferOutput<typeof reportObstacleSchema>;

export type ReportObstacleResult =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly error?: string };

export type ReportObstacleContext = {
  readonly pool: Pool | PoolClient;
  readonly workItemId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly executionId?: string;
  readonly attemptCount?: number;
  readonly sessionRole: AgentSessionRole;
  readonly specialistId?: string;
  readonly provider: string;
  readonly model: string;
};

export function obstacleGroupKey(obstacle: ReportObstacle["obstacle"], subject: string): string {
  return `${obstacle}:${subject.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function obstacleDeliveryKey(input: {
  readonly workItemId: string;
  readonly sessionRole: string;
  readonly specialistId?: string;
  readonly toolCallId: string | null;
}): string | null {
  const toolCallId = input.toolCallId?.trim();
  if (!toolCallId) return null;
  return [input.workItemId, input.sessionRole, input.specialistId ?? "", toolCallId].join("\n");
}

export function reportObstaclePiTool(): PiTool {
  return {
    name: REPORT_OBSTACLE_NAME,
    description: REPORT_OBSTACLE_DESCRIPTION,
    parameters: toToolParameters(reportObstacleSchema),
  };
}

export function createReportObstacleExecutor(
  context: ReportObstacleContext,
): AgentRunnerToolExecutor {
  return async (args, ctx?: AgentToolCallContext): Promise<ReportObstacleResult> => {
    const parsed = parseToolInput(reportObstacleSchema, args, {
      toolName: REPORT_OBSTACLE_NAME,
      errorTitle: "report_obstacle validation failed:",
    });
    if (!parsed.ok) return { recorded: false, error: parsed.error };
    const report = parsed.value;
    try {
      const toolCallId = ctx?.toolCallId?.trim() || null;
      await insertAgentFeedback(context.pool, {
        deliveryKey: obstacleDeliveryKey({
          workItemId: context.workItemId,
          sessionRole: context.sessionRole,
          ...(context.specialistId ? { specialistId: context.specialistId } : {}),
          toolCallId,
        }),
        groupKey: obstacleGroupKey(report.obstacle, report.subject),
        workItemId: context.workItemId,
        installationId: context.installationId,
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        ...(context.executionId != null ? { executionId: context.executionId } : {}),
        ...(context.attemptCount != null ? { attemptCount: context.attemptCount } : {}),
        sessionRole: context.sessionRole,
        ...(context.specialistId ? { specialist: context.specialistId } : {}),
        provider: context.provider,
        model: context.model,
        toolCallId,
        obstacle: report.obstacle,
        subject: report.subject,
        intent: report.intent,
        problem: report.problem,
        expected: report.expected,
        severity: report.severity,
      });
      return { recorded: true };
    } catch (error) {
      logWarn("agent_feedback_insert_failed", {
        workItemId: context.workItemId,
        sessionRole: context.sessionRole,
        specialist: context.specialistId,
        obstacle: report.obstacle,
        message: errorMessage(error),
      });
      return { recorded: false };
    }
  };
}

export function attachReportObstacle(
  session: {
    readonly tools: readonly PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
  },
  context: ReportObstacleContext | null,
): {
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
} {
  const hasSurface = session.tools.length > 0 || Object.keys(session.executors).length > 0;
  if (!hasSurface || session.executors[REPORT_OBSTACLE_NAME]) return session;
  return {
    tools: [...session.tools, reportObstaclePiTool()],
    executors: {
      ...session.executors,
      [REPORT_OBSTACLE_NAME]: context
        ? createReportObstacleExecutor(context)
        : async () => ({ recorded: false }),
    },
  };
}
