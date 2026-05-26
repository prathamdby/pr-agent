import { complete } from "@earendil-works/pi-ai";
import type { Context, Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerProvider, AgentRunnerToolExecutor } from "../interface.js";
import { attachCursorRunContext } from "./runContext.js";
import { getCursorModel } from "./models.js";

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
    let savedTools: PiTool[] | null = null;
    let savedExecutors: Record<string, AgentRunnerToolExecutor> | null = null;

    const syncRunContext = () => {
      attachCursorRunContext(context, {
        executors: activeExecutors,
        apiKey: cfg.cursorApiKey,
        cwd,
        refreshBeforeTool,
      });
    };

    syncRunContext();

    return {
      async send(prompt: string) {
        syncRunContext();
        context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
        const assistant = await complete(model, context, { apiKey: cfg.cursorApiKey });
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
        // Cursor MCP bridge lifecycle is scoped to each complete() call.
      },
    };
  },
};
