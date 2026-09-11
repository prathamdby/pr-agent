import {
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
import type { PromptCacheRetention } from "./promptCachePolicy.js";

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
};

function failureMessage(
  model: Model<Api>,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function encodeFailureStream(
  model: Model<Api>,
  stopReason: "error" | "aborted",
  error: unknown,
): ReturnType<typeof createAssistantMessageEventStream> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const message = failureMessage(model, stopReason, errorMessage);
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
  const streamFn: StreamFn = (model, context: Context, options) => {
    const merged: SimpleStreamOptions = {
      ...defaults,
      ...options,
      cacheRetention: options?.cacheRetention === "none" ? "none" : defaults.cacheRetention,
      sessionId: options?.sessionId ?? defaults.sessionId,
    };
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
  };
}
