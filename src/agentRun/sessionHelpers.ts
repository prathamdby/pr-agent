import type { Api, AssistantMessage, ProviderId } from "@earendil-works/pi-ai";
import { AppError } from "../errors/appError.js";
import type { Config } from "../config.js";
import type { AgentRunnerTurn } from "../agent/providers/interface.js";
import type { PiSession, PiSessionSendOptions } from "../agent/runtime/types.js";

function isApi(value: string): value is Api {
  return value.length > 0;
}

function isProviderId(value: string): value is ProviderId {
  return value.length > 0;
}

function parseApi(value: string): Api {
  if (!isApi(value)) {
    throw new AppError({
      code: "agent.invalid_pi_api",
      message: "piApi is empty",
    });
  }
  return value;
}

function parseProviderId(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new AppError({
      code: "agent.invalid_pi_provider",
      message: "provider is empty",
    });
  }
  return value;
}

type MutablePiSessionSendOptions = {
  -readonly [K in keyof PiSessionSendOptions]: PiSessionSendOptions[K];
};

export function assistantFromText(cfg: Config, text: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: parseApi(cfg.piApi),
    provider: parseProviderId(provider || cfg.piProvider),
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
  const sendOptions: MutablePiSessionSendOptions = {
    phase,
    checkpointId: `${activeSession.role}:${phase}`,
  };
  if (options?.maxToolRounds != null) sendOptions.maxToolRounds = options.maxToolRounds;
  return activeSession.send(activePrompt, sendOptions);
}

/**
 * Send a submit-focused repair nudge without mutating the active tool list.
 * Tool definitions stay registered for the session lifetime (prompt-cache stability).
 */
export async function runSubmitOnlyRound(
  session: PiSession,
  prompt: string,
  sendOrOptions?: SubmitOnlySend | SubmitOnlyRoundOptions,
): Promise<string> {
  const options =
    sendOrOptions != null && !(sendOrOptions instanceof Function) ? sendOrOptions : undefined;
  const send: SubmitOnlySend =
    sendOrOptions instanceof Function
      ? sendOrOptions
      : (active, text) => defaultSubmitOnlySend(active, text, options);

  return (await send(session, prompt)).text;
}
