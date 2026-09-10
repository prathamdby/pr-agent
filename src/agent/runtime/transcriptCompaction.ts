import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";

export const COMPACTION_CUSTOM_INSTRUCTIONS =
  "Preserve the user's task, current phase, accepted findings, pending questions, and artifact references.";

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function isToolResult(message: AgentMessage): boolean {
  return message.role === "toolResult";
}

function serializeForSummary(messages: readonly AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string" ? message.content : contentText(message.content);
      lines.push(`User: ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      const text = contentText(message.content);
      if (text) lines.push(`Assistant: ${text}`);
      continue;
    }
    if (message.role === "toolResult") {
      lines.push(`Tool ${message.toolName}: ${contentText(message.content)}`);
    }
  }
  return lines.join("\n");
}

/** First retained index. Never starts on a toolResult (that would split an assistant/tool pair). */
export function findSafeCutIndex(
  messages: readonly AgentMessage[],
  keepRecentTokens: number,
): number {
  if (messages.length === 0) return 0;
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
    if (index < 0) return 0;
  }
  return Math.max(0, index);
}

async function summarizeMessages(
  messages: readonly AgentMessage[],
  model: Model<Api>,
  streamFn: StreamFn,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const conversationText = serializeForSummary(messages);
  if (conversationText.length === 0) return undefined;
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}\n\nAdditional focus: ${COMPACTION_CUSTOM_INSTRUCTIONS}`;
  const maxTokens = Math.min(
    Math.floor(0.8 * DEFAULT_COMPACTION_SETTINGS.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : 16_384,
  );
  try {
    const stream = await streamFn(
      model,
      {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens, cacheRetention: "none", signal },
    );
    const response = await stream.result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return undefined;
    }
    const text = contentText(response.content).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function compactAgentMessages(params: {
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly signal?: AbortSignal;
}): Promise<AgentMessage[] | undefined> {
  const cut = findSafeCutIndex(params.messages, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  if (cut <= 0) return undefined;
  const summarized = params.messages.slice(0, cut);
  const retained = params.messages.slice(cut);
  const summary = await summarizeMessages(summarized, params.model, params.streamFn, params.signal);
  if (!summary) return undefined;
  const summaryMessage: AgentMessage = {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
    timestamp: Date.now(),
  };
  return [summaryMessage, ...retained];
}

export async function compactIfNeeded(params: {
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly signal?: AbortSignal;
}): Promise<AgentMessage[] | undefined> {
  const usage = estimateContextTokens([...params.messages]);
  if (!shouldCompact(usage.tokens, params.model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    return undefined;
  }
  return compactAgentMessages(params);
}
