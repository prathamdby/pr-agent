import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PromptCacheRetention } from "./promptCachePolicy.js";

/**
 * Force every provider stream/complete entry through the product prompt-cache
 * retention. createAgentSession does not accept a custom streamFn.
 */
export function bindPromptCacheRetention(
  modelRuntime: ModelRuntime,
  retention: PromptCacheRetention,
): void {
  const stream = modelRuntime.stream.bind(modelRuntime);
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  const complete = modelRuntime.complete.bind(modelRuntime);
  const completeSimple = modelRuntime.completeSimple.bind(modelRuntime);

  modelRuntime.stream = ((model, context, options) =>
    stream(model, context, {
      ...(options ?? {}),
      cacheRetention: retention,
    } as never)) as typeof stream;
  modelRuntime.streamSimple = ((model, context, options) =>
    streamSimple(model, context, {
      ...(options ?? {}),
      cacheRetention: retention,
    })) as typeof streamSimple;
  modelRuntime.complete = ((model, context, options) =>
    complete(model, context, {
      ...(options ?? {}),
      cacheRetention: retention,
    } as never)) as typeof complete;
  modelRuntime.completeSimple = ((model, context, options) =>
    completeSimple(model, context, {
      ...(options ?? {}),
      cacheRetention: retention,
    })) as typeof completeSimple;
}
