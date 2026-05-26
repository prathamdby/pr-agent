import { complete } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import type { AgentRunnerProvider } from "../interface.js";
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
    attachCursorRunContext(context, {
      executors,
      apiKey: cfg.cursorApiKey,
      cwd,
      refreshBeforeTool,
    });
    const model = getCursorModel(cfg.piModel);

    return {
      async send(prompt: string) {
        context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
        const assistant = await complete(model, context, { apiKey: cfg.cursorApiKey });
        context.messages.push(assistant);
        return { text: assistantText(assistant) };
      },
      async dispose() {
        // Cursor MCP bridge lifecycle is scoped to each complete() call.
      },
    };
  },
};
