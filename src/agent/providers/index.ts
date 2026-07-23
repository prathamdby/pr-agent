import type { Config } from "../../config.js";
import { AppError } from "../../errors/appError.js";
import type { AgentRunnerProvider } from "./interface.js";
import { piAgentRunnerProvider } from "./pi/index.js";

/** @deprecated Prefer createFeaturePiSession. Kept for piAgentRunnerProvider tests during cleanup. */
export function resolveAgentRunnerProvider(cfg: Config): AgentRunnerProvider {
  if (cfg.agentProvider === "pi") return piAgentRunnerProvider;
  throw new AppError({
    code: "provider.unsupported_agent_provider",
    message: `Unsupported AGENT_PROVIDER: ${String(cfg.agentProvider)}`,
    context: { agentProvider: cfg.agentProvider },
  });
}

export type { AgentRunnerProvider } from "./interface.js";
