import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { approximateCursorUsage, buildCursorPrompt } from "./promptBuilder.js";
import { createMcpBridge } from "./mcpBridge.js";
import { detachCursorRunContext, getCursorRunContext } from "./runContext.js";
import { formatCursorRunError, formatCursorStartupError } from "./errors.js";

function makeInitialMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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

function applyApproximateUsage(
  partial: AssistantMessage,
  inputChars: number,
  outputText: string,
): void {
  const approx = approximateCursorUsage(inputChars, outputText.length);
  partial.usage.input = approx.input;
  partial.usage.output = approx.output;
  partial.usage.totalTokens = approx.totalTokens;
}

function extractFinalText(result: unknown, streamedText: string): string {
  if (typeof result === "string" && result.trim()) return result.trim();
  if (streamedText.trim()) return streamedText.trim();
  return "";
}

export const streamCursor: StreamFunction<"cursor-sdk"> = (model, context, options) => {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const partial = makeInitialMessage(model);
    const runContext = getCursorRunContext(context);
    let bridgeDispose: (() => Promise<void>) | undefined;
    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;

    try {
      stream.push({ type: "start", partial });

      if (!runContext) {
        throw new Error("Cursor run context missing; attach executors before calling complete()");
      }

      const apiKey = options?.apiKey?.trim() || runContext.apiKey;
      if (!apiKey) {
        throw new Error("CURSOR_API_KEY is required for Cursor provider runs");
      }

      const bridge = await createMcpBridge({
        tools: context.tools ?? [],
        executors: runContext.executors,
        signal: options?.signal,
        refreshBeforeTool: runContext.refreshBeforeTool,
        maxToolRounds: runContext.maxToolRounds,
        toolRoundCounter: runContext.toolRoundCounter,
      });
      bridgeDispose = bridge.dispose;

      const { text: promptText, inputChars } = buildCursorPrompt(context);
      const textDeltas: string[] = [];
      let abortListener: (() => void) | undefined;

      agent = await Agent.create({
        apiKey,
        model: { id: model.id },
        local: {
          cwd: runContext.cwd ?? process.cwd(),
          settingSources: [],
        },
        mcpServers: bridge.mcpServers,
      });

      let run: Awaited<ReturnType<typeof agent.send>> | null = null;
      abortListener = () => {
        void run?.cancel().catch(() => undefined);
      };
      options?.signal?.addEventListener("abort", abortListener, { once: true });

      if (options?.signal?.aborted) {
        partial.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: partial });
        return;
      }

      run = await agent.send(
        { text: promptText },
        {
          onDelta: ({ update }) => {
            if (update.type === "text-delta" && "text" in update && update.text) {
              const delta = update.text;
              textDeltas.push(delta);
              const index = partial.content.findIndex((block) => block.type === "text");
              if (index >= 0 && partial.content[index]?.type === "text") {
                partial.content[index].text += delta;
              } else {
                partial.content.push({ type: "text", text: delta });
              }
              stream.push({
                type: "text_delta",
                contentIndex: index >= 0 ? index : partial.content.length - 1,
                delta,
                partial,
              });
            }
          },
        },
      );

      const result = await run.wait();
      const streamedText = textDeltas.join("");
      const finalText = extractFinalText(result.result, streamedText);

      if (result.status === "cancelled" || options?.signal?.aborted) {
        partial.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: partial });
        return;
      }

      if (result.status === "error") {
        partial.stopReason = "error";
        partial.errorMessage = formatCursorRunError(result.id);
        stream.push({ type: "error", reason: "error", error: partial });
        return;
      }

      if (finalText) {
        const textIndex = partial.content.findIndex((block) => block.type === "text");
        if (textIndex >= 0 && partial.content[textIndex]?.type === "text") {
          partial.content[textIndex].text = finalText;
        } else {
          partial.content.push({ type: "text", text: finalText });
        }
      }

      applyApproximateUsage(partial, inputChars, finalText);
      partial.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: partial });
    } catch (error) {
      partial.stopReason = "error";
      if (error instanceof CursorAgentError) {
        partial.errorMessage = formatCursorStartupError(error);
      } else {
        partial.errorMessage = error instanceof Error ? error.message : String(error);
      }
      stream.push({ type: "error", reason: "error", error: partial });
    } finally {
      detachCursorRunContext(context);
      if (agent) {
        const dispose = agent[Symbol.asyncDispose];
        if (typeof dispose === "function") {
          await Promise.resolve(dispose.call(agent)).catch(() => undefined);
        }
      }
      if (bridgeDispose) {
        await bridgeDispose().catch(() => undefined);
      }
      stream.end();
    }
  })();

  return stream;
};

