import { complete } from "@earendil-works/pi-ai";
import type { Context, Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerProvider, AgentRunnerToolExecutor } from "../interface.js";
import { attachCursorRunContext, getCursorRunContext } from "./runContext.js";
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
    attachCursorRunContext(context, {
      executors,
      apiKey: cfg.cursorApiKey,
      cwd,
      refreshBeforeTool,
    });
    const model = getCursorModel(cfg.piModel);
    let savedTools: PiTool[] | null = null;
    let savedExecutors: Record<string, AgentRunnerToolExecutor> | null = null;

    return {
      async send(prompt: string) {
        context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
        const assistant = await complete(model, context, { apiKey: cfg.cursorApiKey });
        context.messages.push(assistant);
        return { text: assistantText(assistant) };
      },
      restrictToTools(nextTools, nextExecutors) {
        savedTools = [...(context.tools ?? [])];
        const runContext = getCursorRunContext(context);
        savedExecutors = runContext ? { ...runContext.executors } : null;
        if (!context.tools) {
          context.tools = [...nextTools];
        } else {
          context.tools.splice(0, context.tools.length, ...nextTools);
        }
        attachCursorRunContext(context, {
          executors: nextExecutors,
          apiKey: cfg.cursorApiKey,
          cwd,
          refreshBeforeTool,
        });
      },
      restoreTools() {
        if (!savedTools) return;
        if (!context.tools) {
          context.tools = [...savedTools];
        } else {
          context.tools.splice(0, context.tools.length, ...savedTools);
        }
        attachCursorRunContext(context, {
          executors: savedExecutors ?? executors,
          apiKey: cfg.cursorApiKey,
          cwd,
          refreshBeforeTool,
        });
        savedTools = null;
        savedExecutors = null;
      },
      async dispose() {
        // Cursor MCP bridge lifecycle is scoped to each complete() call.
      },
    };
  },
};
