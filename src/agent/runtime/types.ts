import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type { JsonObject } from "../../util/jsonValue.js";
import type { AgentRunnerToolExecutor, AgentRunnerTurn } from "../providers/interface.js";
import type { AgentLifecycleEvent } from "./lifecycleEvents.js";
import type { PromptCachePolicy } from "./promptCachePolicy.js";

export type { AgentLifecycleEvent } from "./lifecycleEvents.js";
export type { PromptCachePolicy } from "./promptCachePolicy.js";

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
  /** Resolve the desired thinking level for a phase before clamping. */
  readonly levelForPhase: (phase: AgentSessionPhase) => ThinkingLevel;
};

export type CompactionPolicy = {
  /** When true, Pi SettingsManager enables SDK auto-compaction for the session. */
  readonly enabled: boolean;
};

export type ToolPolicy = {
  /** Built-in shell/write/edit/filesystem tools stay disabled. */
  readonly allowBuiltin: false;
};

/** Server-owned structured state re-injected after compaction / fallback. */
export type AuthoritativeStructuredState = {
  readonly version: number;
  readonly payload: JsonObject;
};

export type PiSessionSendOptions = {
  readonly phase: AgentSessionPhase;
  readonly maxToolRounds?: number;
  readonly deadlineMs?: number;
  readonly checkpointId: string;
};

export type PiSessionCreateParams = {
  readonly role: AgentSessionRole;
  /** Optional specialist persona; included in OpenAI-style session cache identity. */
  readonly specialistId?: string;
  readonly primary: ModelAssignment;
  readonly fallback?: ModelAssignment;
  readonly thinkingPolicy: ThinkingPolicy;
  readonly compactionPolicy: CompactionPolicy;
  readonly promptCachePolicy: PromptCachePolicy;
  readonly toolPolicy: ToolPolicy;
  readonly structuredState: AuthoritativeStructuredState;
  readonly systemPrompt: string;
  readonly cwd?: string;
  readonly eventSink: (event: AgentLifecycleEvent) => void;
  readonly cfg: Config;
  readonly tools: readonly PiTool[];
  readonly executors: Record<string, AgentRunnerToolExecutor>;
  readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
};

export type PiSession = {
  readonly role: AgentSessionRole;
  readonly primary: ModelAssignment;
  readonly send: (prompt: string, opts: PiSessionSendOptions) => Promise<AgentRunnerTurn>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly restartWithFallback: (params: {
    readonly checkpointId: string;
    readonly structuredState: AuthoritativeStructuredState;
  }) => Promise<PiSession>;
  /** Test/harness access to the latest authoritative structured state. */
  readonly getStructuredState: () => AuthoritativeStructuredState;
  readonly setStructuredState: (state: AuthoritativeStructuredState) => void;
};

export const DEFAULT_THINKING_POLICY: ThinkingPolicy = {
  ceiling: "high",
  levelForPhase: (phase) => {
    switch (phase) {
      case "recon":
      case "specialist":
      case "judgment":
        return "medium";
      case "synthesis":
      case "validation_repair":
      case "publish_recovery":
      case "ask":
      case "description":
      case "triage":
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

export const EMPTY_STRUCTURED_STATE: AuthoritativeStructuredState = {
  version: 1,
  payload: {},
};
