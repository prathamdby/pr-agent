import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../settings/index.ts";
import type { AgentRunnerToolExecutor, AgentRunnerTurn } from "../providers/interface.ts";
import type { AgentLifecycleEvent } from "./lifecycleEvents.ts";
import type { PromptCachePolicy } from "./promptCachePolicy.ts";

export type { AgentLifecycleEvent } from "./lifecycleEvents.ts";
export type { PromptCachePolicy } from "./promptCachePolicy.ts";

export type AgentSessionRole =
  | "orchestrator"
  | "specialist"
  | "ask"
  | "description"
  | "triage"
  | "verification"
  | "ci_summary";

export type ModelAssignment = {
  readonly provider: string;
  readonly model: string;
};

export type AgentSessionPhase =
  | "recon"
  | "specialist"
  | "judgment"
  | "synthesis"
  | "validation_repair"
  | "publish_recovery"
  | "ask"
  | "description"
  | "triage"
  | "verification"
  | "ci_summary";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingPolicy = {
  readonly ceiling: ThinkingLevel;
  readonly levelForPhase: (phase: AgentSessionPhase) => ThinkingLevel;
};

export type CompactionPolicy = {
  readonly enabled: boolean;
};

export type ToolPolicy = {
  readonly allowBuiltin: false;
};

export type PiSessionSendOptions = {
  readonly traceValidationRepair?: boolean;
  readonly phase: AgentSessionPhase;
  readonly maxToolRounds?: number;
  readonly reservedTerminalTool?: string;
  readonly deadlineMs?: number;
  readonly checkpointId: string;
};

export type PiSessionCreateParams = {
  readonly traceRole?: "judge";
  readonly traceWorkItemId?: string;
  readonly role: AgentSessionRole;
  readonly specialistId?: string;
  readonly primary: ModelAssignment;
  readonly thinkingPolicy: ThinkingPolicy;
  readonly compactionPolicy: CompactionPolicy;
  readonly promptCachePolicy: PromptCachePolicy;
  readonly toolPolicy: ToolPolicy;
  readonly systemPrompt: string;
  readonly cwd?: string;
  readonly eventSink: (event: AgentLifecycleEvent) => void;
  readonly cfg: Config;
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  readonly hostSignal?: AbortSignal;
};

export type PiSession = {
  readonly role: AgentSessionRole;
  readonly primary: ModelAssignment;
  readonly send: (prompt: string, opts: PiSessionSendOptions) => Promise<AgentRunnerTurn>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => Promise<void>;
};

export const DEFAULT_THINKING_POLICY: ThinkingPolicy = {
  ceiling: "high",
  levelForPhase: (phase) => {
    switch (phase) {
      case "recon":
      case "specialist":
      case "judgment":
      case "ask":
      case "triage":
        return "medium";
      case "synthesis":
      case "validation_repair":
      case "publish_recovery":
      case "description":
      case "verification":
      case "ci_summary":
        return "low";
      default: {
        const _exhaustive: never = phase;
        return _exhaustive;
      }
    }
  },
};

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  allowBuiltin: false,
};
