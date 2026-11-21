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
import { isRecord } from "../../util/typeGuards.ts";
import {
  comparePromptCacheSections,
  promptCacheSections,
  splitAnthropicSystemBlocks,
  systemPromptStartsWithSpecialistPrefix,
  type PromptCacheBreak,
  type PromptCacheRetention,
  type PromptCacheSections,
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
  readonly promptCacheKey?: string;
  readonly sharedSystemHead?: string;
  readonly recordCacheBreak?: (observed: PromptCacheBreak) => void;
};

const OPENAI_PROMPT_CACHE_KEY_APIS = new Set<string>(["openai-completions", "openai-responses"]);

function withPromptCacheKey(payload: unknown, promptCacheKey: string) {
  if (!isRecord(payload)) return ((pinnedReturn: unknown) => pinnedReturn)(payload);
  return ((pinnedReturn: unknown) => pinnedReturn)({
    ...payload,
    prompt_cache_key: promptCacheKey,
  });
}

export type SessionStream = {
  readonly streamFn: StreamFn;
  readonly getLastOptions: () => SimpleStreamOptions | undefined;
  readonly getAttempts: () => number;
};

function failureMessage(model: Model<Api>, stopReason: "error" | "aborted", reason: string) {
  return ((pinnedReturn: AssistantMessage) => pinnedReturn)({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: reason,
    timestamp: Date.now(),
  });
}

function requestSystemText(context: Context) {
  if (typeof context.systemPrompt === "string" && context.systemPrompt.length > 0) {
    return ((pinnedReturn: string) => pinnedReturn)(context.systemPrompt);
  }
  for (const message of context.messages) {
    if (message.role === "system")
      return ((pinnedReturn: string) => pinnedReturn)(contentText(message.content));
  }
  return ((pinnedReturn: string) => pinnedReturn)("");
}

function encodeFailureStream(model: Model<Api>, stopReason: "error" | "aborted", error: unknown) {
  const message = failureMessage(model, stopReason, errorMessage(error));
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: stopReason, error: message });
  stream.end(message);
  return ((pinnedReturn: ReturnType<typeof createAssistantMessageEventStream>) => pinnedReturn)(
    stream,
  );
}

export function createSessionStreamFn(models: Models, defaults: SessionStreamDefaults) {
  let lastOptions: SimpleStreamOptions | undefined;
  let attempts = 0;
  let previousSections: PromptCacheSections | null = null;
  const streamFn: StreamFn = (model, context: Context, options) => {
    attempts += 1;
    const systemText = requestSystemText(context);
    const sections = promptCacheSections({
      systemText,
      tools: context.tools,
      history: context.messages.filter((message) => message.role !== "system"),
      ...(defaults.sharedSystemHead != null ? { sharedHead: defaults.sharedSystemHead } : {}),
    });
    if (previousSections && defaults.recordCacheBreak) {
      defaults.recordCacheBreak(comparePromptCacheSections(previousSections, sections));
    }
    previousSections = sections;
    const merged: SimpleStreamOptions = {
      ...defaults,
      ...options,
      cacheRetention: options?.cacheRetention === "none" ? "none" : defaults.cacheRetention,
      sessionId: options?.sessionId ?? defaults.sessionId,
    };
    const anthropicSharedHead =
      defaults.sharedSystemHead != null
        ? systemText.startsWith(defaults.sharedSystemHead)
          ? defaults.sharedSystemHead
          : undefined
        : systemPromptStartsWithSpecialistPrefix(systemText)
          ? specialistSharedPrefix
          : undefined;
    if (model.api === "anthropic-messages" && anthropicSharedHead != null) {
      const installed = merged.onPayload;
      merged.onPayload = async (payload, payloadModel) => {
        const split = splitAnthropicSystemBlocks(payload, anthropicSharedHead);
        if (!installed) return split;
        const next = await installed(split, payloadModel);
        return next === undefined ? split : next;
      };
    }
    if (defaults.promptCacheKey != null && OPENAI_PROMPT_CACHE_KEY_APIS.has(model.api)) {
      const installed = merged.onPayload;
      const promptCacheKey = defaults.promptCacheKey;
      merged.onPayload = async (payload, payloadModel) => {
        const injected = withPromptCacheKey(payload, promptCacheKey);
        if (!installed) return injected;
        const next = await installed(injected, payloadModel);
        return next === undefined ? injected : next;
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
  return ((pinnedReturn: SessionStream) => pinnedReturn)({
    streamFn,
    getLastOptions: () => lastOptions,
    getAttempts: () => attempts,
  });
}
