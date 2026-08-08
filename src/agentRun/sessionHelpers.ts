import type { Api, AssistantMessage, ProviderId } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { AgentRunnerTurn } from "../agent/providers/interface.js";
import type { PiSession } from "../agent/runtime/types.js";

export function assistantFromText(cfg: Config, text: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: cfg.piApi as Api,
    provider: (provider || cfg.piProvider) as ProviderId,
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

export type SubmitOnlySend = (session: PiSession, prompt: string) => Promise<AgentRunnerTurn>;

export type SubmitOnlyRoundOptions = {
  readonly maxToolRounds?: number;
};

function defaultSubmitOnlySend(
  activeSession: PiSession,
  activePrompt: string,
  options?: SubmitOnlyRoundOptions,
): Promise<AgentRunnerTurn> {
  const phase = activeSession.role === "orchestrator" ? "synthesis" : activeSession.role;
  return activeSession.send(activePrompt, {
    phase,
    checkpointId: `${activeSession.role}:${phase}`,
    ...(options?.maxToolRounds != null ? { maxToolRounds: options.maxToolRounds } : {}),
  });
}

/**
 * Send a submit-focused repair nudge without mutating the active tool list.
 * Tool definitions stay registered for the session lifetime (prompt-cache stability).
 */
export async function runSubmitOnlyRound(
  session: PiSession,
  _submitOnly: {
    readonly piTools: readonly unknown[];
    readonly executors: Record<string, unknown>;
  },
  prompt: string,
  sendOrOptions?: SubmitOnlySend | SubmitOnlyRoundOptions,
): Promise<string> {
  const options =
    sendOrOptions != null && typeof sendOrOptions !== "function" ? sendOrOptions : undefined;
  const send: SubmitOnlySend =
    typeof sendOrOptions === "function"
      ? sendOrOptions
      : (active, text) => defaultSubmitOnlySend(active, text, options);

  return (await send(session, prompt)).text;
}
