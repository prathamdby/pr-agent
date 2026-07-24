import type { AgentRunnerTurn } from "./usageMetadata.js";

export type { AgentRunnerTurn };

export type AgentRunnerToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;
