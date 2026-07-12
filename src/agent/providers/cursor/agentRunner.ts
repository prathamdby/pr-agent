import { complete } from "@earendil-works/pi-ai";
import type { Context, Tool as PiTool } from "@earendil-works/pi-ai";
import { Agent } from "@cursor/sdk";
import type {
  AgentRunnerProvider,
  AgentRunnerSendOptions,
  AgentRunnerToolExecutor,
} from "../interface.js";
import { estimatedUsageFromTokenCounts } from "../usageMetadata.js";
import { attachCursorRunContext } from "./runContext.js";
import { getCursorModel, toCursorSdkModelSelection } from "./models.js";
import { buildCursorSendText } from "./promptBuilder.js";
import { createMcpBridge } from "./mcpBridge.js";
import { assertCursorRipgrepConfigured } from "./ripgrepBoot.js";
import { initCursorWorker, type CursorWorkerBootInfo } from "./workerBoot.js";

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertCursorWorkerBootInfo(value: unknown): CursorWorkerBootInfo {
  if (value == null || typeof value !== "object") {
    throw new Error("Cursor worker boot returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  const { modelCount, topModels, fastModels, ripgrepPath } = result;
  if (
    typeof modelCount !== "number" ||
    !isStringArray(topModels) ||
    !isStringArray(fastModels) ||
    (ripgrepPath !== undefined && typeof ripgrepPath !== "string")
  ) {
    throw new Error("Cursor worker boot returned an invalid result");
  }
  return {
    modelCount,
    topModels,
    fastModels,
    ...(ripgrepPath === undefined ? {} : { ripgrepPath }),
  };
}

function assistantText(content: Context["messages"][number]): string {
  if (content.role !== "assistant" || !Array.isArray(content.content)) return "";
  return content.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export const cursorAgentRunnerProvider: AgentRunnerProvider = {
  async boot(cfg) {
    return assertCursorWorkerBootInfo(await initCursorWorker(cfg));
  },
  async createSession({
    cfg,
    cwd,
    systemPrompt,
    tools,
    executors,
    refreshBeforeTool,
    signal,
    onToolCallMetric,
  }) {
    signal?.throwIfAborted();
    const sessionAbortController = new AbortController();
    const forwardSessionAbort = () => sessionAbortController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardSessionAbort, { once: true });
    const context: Context = {
      systemPrompt,
      messages: [],
      tools: [...tools],
    };
    let activeExecutors = executors;
    const model = getCursorModel(cfg.piModel);
    const sdkModelSelection = toCursorSdkModelSelection(cfg.piModel);
    let savedTools: PiTool[] | null = null;
    let savedExecutors: Record<string, AgentRunnerToolExecutor> | null = null;
    let activeMaxToolRounds: number | undefined;
    let activeSendSignal: AbortSignal = sessionAbortController.signal;
    const toolRoundCounter = { count: 0 };
    const apiKey = cfg.cursorApiKey?.trim();
    if (!apiKey) {
      throw new Error("CURSOR_API_KEY is required for Cursor provider runs");
    }
    assertCursorRipgrepConfigured();
    const bridge = await createMcpBridge({
      tools: () => context.tools ?? [],
      executors: () => activeExecutors,
      refreshBeforeTool,
      signal: () => activeSendSignal,
      maxToolRounds: () => activeMaxToolRounds,
      toolRoundCounter,
      onToolCallMetric,
    });
    const agent = await Agent.create({
      apiKey,
      model: sdkModelSelection,
      local: {
        cwd: cwd ?? process.cwd(),
        settingSources: [],
      },
      mcpServers: bridge.mcpServers,
    });
    let disposed = false;

    const syncRunContext = (maxToolRounds?: number) => {
      activeMaxToolRounds = maxToolRounds;
      attachCursorRunContext(context, {
        executors: activeExecutors,
        apiKey,
        sdkModelSelection,
        cwd,
        refreshBeforeTool,
        maxToolRounds,
        toolRoundCounter,
        agent,
        bridge,
      });
    };

    syncRunContext();

    return {
      async send(prompt: string, opts?: AgentRunnerSendOptions) {
        activeSendSignal = opts?.signal
          ? AbortSignal.any([sessionAbortController.signal, opts.signal])
          : sessionAbortController.signal;
        try {
          activeSendSignal.throwIfAborted();
          toolRoundCounter.count = 0;
          syncRunContext(opts?.maxToolRounds ?? activeMaxToolRounds);
          context.messages.push({
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          });
          const { text: sendText, inputChars } = buildCursorSendText(context, {
            reuseAgentConversation: true,
          });
          const assistant = await complete(model, context, {
            apiKey: cfg.cursorApiKey,
            signal: activeSendSignal,
          });
          activeSendSignal.throwIfAborted();
          context.messages.push(assistant);
          return {
            text: assistantText(assistant),
            prompt: {
              inputCharacters: inputChars,
              inputBytes: Buffer.byteLength(sendText, "utf8"),
            },
            usage: estimatedUsageFromTokenCounts(assistant.usage.input, assistant.usage.output),
          };
        } finally {
          activeSendSignal = sessionAbortController.signal;
        }
      },
      async cancel() {
        sessionAbortController.abort();
      },
      restrictToTools(nextTools, nextExecutors) {
        savedTools = [...(context.tools ?? [])];
        savedExecutors = { ...activeExecutors };
        if (!context.tools) {
          context.tools = [...nextTools];
        } else {
          context.tools.splice(0, context.tools.length, ...nextTools);
        }
        activeExecutors = nextExecutors;
        syncRunContext();
      },
      restoreTools() {
        if (!savedTools) return;
        if (!context.tools) {
          context.tools = [...savedTools];
        } else {
          context.tools.splice(0, context.tools.length, ...savedTools);
        }
        activeExecutors = savedExecutors ?? executors;
        syncRunContext();
        savedTools = null;
        savedExecutors = null;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        sessionAbortController.abort();
        signal?.removeEventListener("abort", forwardSessionAbort);
        const disposeAgent = agent[Symbol.asyncDispose];
        await Promise.allSettled([
          typeof disposeAgent === "function"
            ? Promise.resolve(disposeAgent.call(agent))
            : Promise.resolve(),
          bridge.dispose(),
        ]);
      },
    };
  },
};
