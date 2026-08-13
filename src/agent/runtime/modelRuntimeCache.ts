import type { PromptCacheRetention } from "./promptCachePolicy.js";

export type PromptCacheModelRef = {
  readonly id: string;
};

export type PromptCacheContextRef = {
  readonly messages: readonly never[];
};

export type PromptCacheStreamOptions = {
  cacheRetention?: string;
  maxTokens?: number;
};

export type PromptCacheRuntime = {
  stream(
    model: PromptCacheModelRef,
    context: PromptCacheContextRef,
    options?: PromptCacheStreamOptions,
  ): void;
  streamSimple(
    model: PromptCacheModelRef,
    context: PromptCacheContextRef,
    options?: PromptCacheStreamOptions,
  ): void;
  complete(
    model: PromptCacheModelRef,
    context: PromptCacheContextRef,
    options?: PromptCacheStreamOptions,
  ): void;
  completeSimple(
    model: PromptCacheModelRef,
    context: PromptCacheContextRef,
    options?: PromptCacheStreamOptions,
  ): void;
};

/**
 * Force every provider stream/complete entry through the product prompt-cache
 * retention. createAgentSession does not accept a custom streamFn.
 */
export function bindPromptCacheRetention(
  modelRuntime: PromptCacheRuntime,
  retention: PromptCacheRetention,
): void {
  const stream = modelRuntime.stream.bind(modelRuntime);
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  const complete = modelRuntime.complete.bind(modelRuntime);
  const completeSimple = modelRuntime.completeSimple.bind(modelRuntime);

  modelRuntime.stream = (model, context, options) => {
    if (options !== undefined) options.cacheRetention = retention;
    return stream(model, context, options);
  };
  modelRuntime.streamSimple = (model, context, options) => {
    if (options !== undefined) options.cacheRetention = retention;
    return streamSimple(model, context, options);
  };
  modelRuntime.complete = (model, context, options) => {
    if (options !== undefined) options.cacheRetention = retention;
    return complete(model, context, options);
  };
  modelRuntime.completeSimple = (model, context, options) => {
    if (options !== undefined) options.cacheRetention = retention;
    return completeSimple(model, context, options);
  };
}
