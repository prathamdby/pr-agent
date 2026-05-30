import type { Config } from "../../config.js";
import type { AgentRunnerProvider } from "./interface.js";
import { cursorAgentRunnerProvider } from "./cursor/agentRunner.js";
import { piAgentRunnerProvider } from "./pi/index.js";

export function resolveAgentRunnerProvider(cfg: Config): AgentRunnerProvider {
  if (cfg.agentProvider === "cursor") return cursorAgentRunnerProvider;
  if (cfg.agentProvider === "pi") return piAgentRunnerProvider;
  throw new Error(`Unsupported AGENT_PROVIDER: ${String(cfg.agentProvider)}`);
}

export type { AgentRunnerProvider } from "./interface.js";
