import type { Api, AssistantMessage, KnownProvider, Provider } from "@earendil-works/pi-ai";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { AgentRunnerSession, AgentRunnerTurn } from "../agent/providers/interface.js";
import { CURSOR_API, CURSOR_PROVIDER } from "../agent/providers/cursor/models.js";

function sessionAssistantApi(runProvider: string, piProvider: KnownProvider): Api {
  return runProvider === CURSOR_PROVIDER ? CURSOR_API : (piProvider as Api);
}

function sessionAssistantProvider(runProvider: string, piProvider: KnownProvider): Provider {
  return runProvider === CURSOR_PROVIDER ? CURSOR_PROVIDER : piProvider;
}

export function assistantFromText(cfg: Config, text: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: sessionAssistantApi(provider, cfg.piProvider),
    provider: sessionAssistantProvider(provider, cfg.piProvider),
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

export async function runSubmitOnlyRound(
  session: AgentRunnerSession,
  submitOnly: {
    readonly piTools: readonly PiTool[];
    readonly executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  },
  prompt: string,
  send: (session: AgentRunnerSession, prompt: string) => Promise<AgentRunnerTurn> = (
    activeSession,
    activePrompt,
  ) => activeSession.send(activePrompt),
): Promise<string> {
  session.restrictToTools(submitOnly.piTools, submitOnly.executors);
  try {
    return (await send(session, prompt)).text;
  } finally {
    session.restoreTools();
  }
}
