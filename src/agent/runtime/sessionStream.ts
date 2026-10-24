import {
  contentText,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type Usage,
  type Api,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { errorMessage } from "../../errors/errorMessage.ts";
import { specialistSharedPrefix } from "../../prompts/shared/prefix.ts";
import {
  splitAnthropicSystemBlocks,
  systemPromptStartsWithSpecialistPrefix,
  type PromptCacheRetention,
} from "./promptCachePolicy.ts";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type SessionStreamDefaults = {
  readonly cacheRetention: PromptCacheRetention;
  readonly sessionId: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number;
};

export type SessionStream = {
  readonly streamFn: StreamFn;
  readonly getLastOptions: () => SimpleStreamOptions | undefined;
  readonly getAttempts: () => number;
};

function failureMessage(
  model: Model<Api>,
  stopReason: "error" | "aborted",
  reason: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: reason,
    timestamp: Date.now(),
  };
}

function requestSystemText(context: Context): string {
  if (typeof context.systemPrompt === "string" && context.systemPrompt.length > 0) {
    return context.systemPrompt;
  }
  for (const message of context.messages) {
    if (message.role === "system") return contentText(message.content);
  }
  return "";
}

function encodeFailureStream(
  model: Model<Api>,
  stopReason: "error" | "aborted",
  error: unknown,
): ReturnType<typeof createAssistantMessageEventStream> {
  const message = failureMessage(model, stopReason, errorMessage(error));
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: stopReason, error: message });
  stream.end(message);
  return stream;
}

export function createSessionStreamFn(
  models: Models,
  defaults: SessionStreamDefaults,
): SessionStream {
  let lastOptions: SimpleStreamOptions | undefined;
  let attempts = 0;
  const streamFn: StreamFn = (model, context: Context, options) => {
    attempts += 1;
    const merged: SimpleStreamOptions = {
      ...defaults,
      ...options,
      cacheRetention: options?.cacheRetention === "none" ? "none" : defaults.cacheRetention,
      sessionId: options?.sessionId ?? defaults.sessionId,
    };
    if (
      model.api === "anthropic-messages" &&
      systemPromptStartsWithSpecialistPrefix(requestSystemText(context))
    ) {
      const installed = merged.onPayload;
      merged.onPayload = async (payload, payloadModel) => {
        const split = splitAnthropicSystemBlocks(payload, specialistSharedPrefix);
        if (!installed) return split;
        const next = await installed(split, payloadModel);
        return next === undefined ? split : next;
      };
    }
    lastOptions = merged;
    try {
      return models.streamSimple(model, context, merged);
    } catch (error) {
      const aborted = merged.signal?.aborted === true;
      return encodeFailureStream(model, aborted ? "aborted" : "error", error);
    }
  };
  return {
    streamFn,
    getLastOptions: () => lastOptions,
    getAttempts: () => attempts,
  };
}
