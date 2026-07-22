import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";
import type {
  AgentRunnerPromptMetadata,
  AgentRunnerTurn,
  AgentRunnerUsageMetadata,
} from "./usageMetadata.js";

export type { AgentRunnerPromptMetadata, AgentRunnerTurn, AgentRunnerUsageMetadata };

export type AgentRunnerToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

export type AgentRunnerSendOptions = {
  readonly maxToolRounds?: number;
};

export type AgentRunnerSession = {
  readonly send: (prompt: string, opts?: AgentRunnerSendOptions) => Promise<AgentRunnerTurn>;
  readonly abort: () => Promise<void>;
  readonly restrictToTools: (
    tools: readonly PiTool[],
    executors: Record<string, AgentRunnerToolExecutor>,
  ) => void;
  readonly restoreTools: () => void;
  readonly dispose: () => Promise<void>;
};

type AgentProviderBootResult = {
  readonly modelCount: number;
  readonly topModels: readonly string[];
  readonly fastModels: readonly string[];
  readonly ripgrepPath?: string;
};

export type AgentRunnerProvider = {
  readonly boot?: (cfg: Config) => Promise<AgentProviderBootResult | undefined>;
  readonly createSession: (params: {
    readonly cfg: Config;
    readonly cwd?: string;
    readonly systemPrompt: string;
    readonly tools: readonly PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
    readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  }) => Promise<AgentRunnerSession>;
};
