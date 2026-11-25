import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  contentText,
  getSupportedThinkingLevels,
  normalizeContext,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { SessionTrace } from "./sessionTrace.ts";
import { clampThinkingLevel } from "./thinkingPolicy.ts";
import type { ThinkingLevel } from "./types.ts";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  SUMMARIZATION_SYSTEM_PROMPT,
  renderCompactionUserPrompt,
} from "../../prompts/compaction/prompt.ts";

const COMPACTION_RESERVE_TOKENS = 16_384;
const COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const ESTIMATED_IMAGE_CHARS = 4_800;

function isToolResult(message: AgentMessage) {
  return ((pinnedReturn: boolean) => pinnedReturn)(message.role === "toolResult");
}

function safeJsonStringify(value: unknown) {
  try {
    return ((pinnedReturn: string) => pinnedReturn)(JSON.stringify(value) ?? "undefined");
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)("[unserializable]");
  }
}

function contextTokens(usage: {
  readonly totalTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}) {
  return ((pinnedReturn: number) => pinnedReturn)(
    usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
  );
}

function assistantUsage(message: AgentMessage) {
  if (message.role !== "assistant" || !("usage" in message)) return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
  if (!message.usage || contextTokens(message.usage) <= 0) return undefined;
  return message.usage;
}

function estimateContextTokens(messages: readonly AgentMessage[]) {
  let usageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && assistantUsage(message)) {
      usageIndex = index;
      break;
    }
  }
  if (usageIndex < 0) {
    return ((pinnedReturn: number) => pinnedReturn)(
      messages.reduce((total, message) => total + estimateTokens(message), 0),
    );
  }
  const usageMessage = messages[usageIndex];
  const usage = usageMessage ? assistantUsage(usageMessage) : undefined;
  const reported = usage ? contextTokens(usage) : 0;
  let trailing = 0;
  for (const message of messages.slice(usageIndex + 1)) trailing += estimateTokens(message);
  return ((pinnedReturn: number) => pinnedReturn)(reported + trailing);
}

function contextNeedsCompaction(tokens: number, contextWindow: number) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    tokens > contextWindow - COMPACTION_RESERVE_TOKENS,
  );
}

function estimateTextAndImageChars(
  content: string | readonly { readonly type: string; readonly text?: string }[],
) {
  if (typeof content === "string") return ((pinnedReturn: number) => pinnedReturn)(content.length);
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return ((pinnedReturn: number) => pinnedReturn)(chars);
}

function estimateTokens(message: AgentMessage) {
  if (message.role === "user" || message.role === "toolResult") {
    return ((pinnedReturn: number) => pinnedReturn)(
      Math.ceil(estimateTextAndImageChars(message.content) / 4),
    );
  }
  if (message.role !== "assistant") return ((pinnedReturn: number) => pinnedReturn)(0);
  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") {
      chars += block.name.length + safeJsonStringify(block.arguments).length;
    }
  }
  return ((pinnedReturn: number) => pinnedReturn)(Math.ceil(chars / 4));
}

function serializeForSummary(messages: readonly AgentMessage[]) {
  const lines: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text =
          typeof message.content === "string" ? message.content : contentText(message.content);
        lines.push(`User: ${text}`);
        break;
      }
      case "assistant": {
        const text = contentText(message.content);
        if (text) lines.push(`Assistant: ${text}`);
        break;
      }
      case "toolResult":
        lines.push(`Tool ${message.toolName}: ${contentText(message.content)}`);
        break;
    }
  }
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

export function findSafeCutIndex(messages: readonly AgentMessage[], keepRecentTokens: number) {
  if (messages.length === 0) return ((pinnedReturn: number) => pinnedReturn)(0);
  let tokens = 0;
  let index = messages.length;
  while (index > 0) {
    const previous = messages[index - 1];
    if (!previous) break;
    const nextTokens = tokens + estimateTokens(previous);
    if (tokens > 0 && nextTokens > keepRecentTokens) break;
    tokens = nextTokens;
    index -= 1;
  }
  while (index < messages.length) {
    const current = messages[index];
    if (!current || !isToolResult(current)) break;
    index -= 1;
    if (index < 0) return ((pinnedReturn: number) => pinnedReturn)(0);
  }
  return ((pinnedReturn: number) => pinnedReturn)(Math.max(0, index));
}

async function summarizeMessages(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  streamFn: StreamFn,
  signal: AbortSignal | undefined,
  thinkingCeiling: ThinkingLevel,
  trace?: SessionTrace,
  onStreamEvent?: () => void,
) {
  const conversationText = serializeForSummary(messages);
  if (conversationText.length === 0)
    return ((pinnedReturn: (string | undefined) | Promise<string | undefined>) => pinnedReturn)(
      undefined,
    );
  const reasoning = clampThinkingLevel("low", thinkingCeiling);
  const promptText = renderCompactionUserPrompt(conversationText);
  const maxTokens = Math.min(
    Math.floor(0.8 * COMPACTION_RESERVE_TOKENS),
    model.maxTokens > 0 ? model.maxTokens : 16_384,
  );
  try {
    trace?.beginCompaction(SUMMARIZATION_SYSTEM_PROMPT, promptText);
    const stream = await streamFn(
      model,
      normalizeContext({
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
          },
        ],
      }),
      {
        maxTokens,
        cacheRetention: "none",
        signal,
        ...(reasoning !== "off" && getSupportedThinkingLevels(model).includes(reasoning)
          ? { reasoning }
          : {}),
      },
    );
    if (onStreamEvent) {
      void (async () => {
        for await (const streamEvent of stream) {
          void streamEvent;
          onStreamEvent();
        }
      })().catch(() => undefined);
    }
    const response = await stream.result();
    trace?.endCompaction(response);
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return ((pinnedReturn: (string | undefined) | Promise<string | undefined>) => pinnedReturn)(
        undefined,
      );
    }
    const text = contentText(response.content).trim();
    return ((pinnedReturn: (string | undefined) | Promise<string | undefined>) => pinnedReturn)(
      text.length > 0 ? text : undefined,
    );
  } catch {
    trace?.endCompaction(undefined);
    return ((pinnedReturn: (string | undefined) | Promise<string | undefined>) => pinnedReturn)(
      undefined,
    );
  }
}

function thinkingBoundToPrefix(model: Model<Api>) {
  const compat = model.compat;
  return ((pinnedReturn: boolean) => pinnedReturn)(
    model.api === "anthropic-messages" &&
      compat != null &&
      "forceAdaptiveThinking" in compat &&
      compat.forceAdaptiveThinking === true,
  );
}

function withoutThinking(message: AgentMessage) {
  if (message.role !== "assistant") return ((pinnedReturn: AgentMessage) => pinnedReturn)(message);
  if (!message.content.some((part) => part.type === "thinking"))
    return ((pinnedReturn: AgentMessage) => pinnedReturn)(message);
  return ((pinnedReturn: AgentMessage) => pinnedReturn)({
    ...message,
    content: message.content.filter((part) => part.type !== "thinking"),
  });
}

export async function compactAgentMessages(params: {
  readonly trace?: SessionTrace;
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly signal?: AbortSignal;
  readonly thinkingCeiling: ThinkingLevel;
  readonly onStreamEvent?: () => void;
}) {
  const leadingSystem: AgentMessage[] = [];
  let restStart = 0;
  while (restStart < params.messages.length && params.messages[restStart]?.role === "system") {
    const systemMessage = params.messages[restStart];
    if (!systemMessage) break;
    leadingSystem.push(systemMessage);
    restStart += 1;
  }
  const rest = params.messages.slice(restStart);
  const cut = findSafeCutIndex(rest, COMPACTION_KEEP_RECENT_TOKENS);
  if (cut <= 0)
    return ((pinnedReturn: (AgentMessage[] | undefined) | Promise<AgentMessage[] | undefined>) =>
      pinnedReturn)(undefined);
  const summarized = rest.slice(0, cut);
  const retained = thinkingBoundToPrefix(params.model)
    ? rest.slice(cut).map(withoutThinking)
    : rest.slice(cut);
  const summary = await summarizeMessages(
    summarized,
    params.model,
    params.streamFn,
    params.signal,
    params.thinkingCeiling,
    params.trace,
    params.onStreamEvent,
  );
  if (!summary)
    return ((pinnedReturn: (AgentMessage[] | undefined) | Promise<AgentMessage[] | undefined>) =>
      pinnedReturn)(undefined);
  const summaryMessage: AgentMessage = {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
    timestamp: Date.now(),
  };
  return ((pinnedReturn: (AgentMessage[] | undefined) | Promise<AgentMessage[] | undefined>) =>
    pinnedReturn)([...leadingSystem, summaryMessage, ...retained]);
}

export async function compactIfNeeded(params: {
  readonly trace?: SessionTrace;
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly signal?: AbortSignal;
  readonly thinkingCeiling: ThinkingLevel;
  readonly onStreamEvent?: () => void;
}) {
  const usage = estimateContextTokens(params.messages);
  if (!contextNeedsCompaction(usage, params.model.contextWindow)) {
    return ((pinnedReturn: (AgentMessage[] | undefined) | Promise<AgentMessage[] | undefined>) =>
      pinnedReturn)(undefined);
  }
  return ((pinnedReturn: (AgentMessage[] | undefined) | Promise<AgentMessage[] | undefined>) =>
    pinnedReturn)(compactAgentMessages(params));
}

export function dropTrailingErrorAssistant(messages: AgentMessage[]) {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && "stopReason" in last && last.stopReason === "error") {
    messages.pop();
  }
}
