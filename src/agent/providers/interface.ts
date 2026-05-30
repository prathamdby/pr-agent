import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../../config.js";

export type AgentRunnerToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

type AgentRunnerTurn = {
  readonly text: string;
};

export type AgentRunnerSendOptions = {
  readonly maxToolRounds?: number;
};

export type AgentRunnerSession = {
  readonly send: (prompt: string, opts?: AgentRunnerSendOptions) => Promise<AgentRunnerTurn>;
  readonly restrictToTools: (
    tools: readonly PiTool[],
    executors: Record<string, AgentRunnerToolExecutor>,
  ) => void;
  readonly restoreTools: () => void;
  readonly dispose: () => Promise<void>;
};

export type AgentRunnerProvider = {
  readonly createSession: (params: {
    readonly cfg: Config;
    readonly cwd?: string;
    readonly systemPrompt: string;
    readonly tools: readonly PiTool[];
    readonly executors: Record<string, AgentRunnerToolExecutor>;
    readonly refreshBeforeTool?: (toolName: string) => Promise<void>;
  }) => Promise<AgentRunnerSession>;
};
