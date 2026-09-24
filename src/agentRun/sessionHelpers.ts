import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { AgentRunnerTurn } from "../agent/providers/interface.js";
import type { PiSession } from "../agent/runtime/types.js";
import { SUBMIT_ONLY_MAX_TOOL_ROUNDS } from "../settings/index.js";

export function assistantFromText(cfg: Config, text: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: cfg.piApi,
    provider: provider || cfg.piProvider,
    model: cfg.piModel,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export type SubmitOnlySend = (
  session: PiSession,
  prompt: string,
  opts: { readonly maxToolRounds: number },
) => Promise<AgentRunnerTurn>;

const defaultSubmitOnlySend: SubmitOnlySend = (activeSession, activePrompt, opts) => {
  const phase = activeSession.role === "orchestrator" ? "synthesis" : activeSession.role;
  return activeSession.send(activePrompt, {
    phase,
    checkpointId: `${activeSession.role}:${phase}`,
    maxToolRounds: opts.maxToolRounds,
  });
};

/**
 * Send a submit-focused repair nudge without mutating the active tool list.
 * Tool definitions stay registered for the session lifetime (prompt-cache stability).
 */
export async function runSubmitOnlyRound(
  session: PiSession,
  prompt: string,
  send: SubmitOnlySend = defaultSubmitOnlySend,
): Promise<string> {
  return (await send(session, prompt, { maxToolRounds: SUBMIT_ONLY_MAX_TOOL_ROUNDS })).text;
}
