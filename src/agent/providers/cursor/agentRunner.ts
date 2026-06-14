import { complete } from "@earendil-works/pi-ai";
import type { Context, Tool as PiTool } from "@earendil-works/pi-ai";
import { Agent } from "@cursor/sdk";
import type {
  AgentRunnerProvider,
  AgentRunnerSendOptions,
  AgentRunnerToolExecutor,
} from "../interface.js";
import { attachCursorRunContext } from "./runContext.js";
import { getCursorModel, toCursorSdkModelSelection } from "./models.js";
import { createMcpBridge } from "./mcpBridge.js";
import { assertCursorRipgrepConfigured } from "./ripgrepBoot.js";

function assistantText(content: Context["messages"][number]): string {
  if (content.role !== "assistant" || !Array.isArray(content.content)) return "";
  return content.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export const cursorAgentRunnerProvider: AgentRunnerProvider = {
  async createSession({ cfg, cwd, systemPrompt, tools, executors, refreshBeforeTool }) {
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
      maxToolRounds: () => activeMaxToolRounds,
      toolRoundCounter,
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
        toolRoundCounter.count = 0;
        syncRunContext(opts?.maxToolRounds ?? activeMaxToolRounds);
        context.messages.push({
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        });
        const assistant = await complete(model, context, {
          apiKey: cfg.cursorApiKey,
        });
        context.messages.push(assistant);
        return { text: assistantText(assistant) };
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
