import type {
  Api,
  AssistantMessage,
  KnownProvider,
  Provider,
  Tool as PiTool,
} from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { AgentRunnerSession } from "./providers/interface.js";
import { CURSOR_API, CURSOR_PROVIDER } from "./providers/cursor/models.js";

export function activeToolNames(tools: readonly PiTool[]): string[] {
  return tools.map((tool) => tool.name);
}

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
): Promise<string> {
  session.restrictToTools(submitOnly.piTools, submitOnly.executors);
  try {
    return (await session.send(prompt)).text;
  } finally {
    session.restoreTools();
  }
}
