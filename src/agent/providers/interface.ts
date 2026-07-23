import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerTurn } from "./usageMetadata.js";

export type { AgentRunnerTurn };

export type AgentRunnerToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

export type AgentRunnerSendOptions = {
  readonly maxToolRounds?: number;
  /** Optional Pi session phase for thinking/metrics attribution during migration. */
  readonly phase?:
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
