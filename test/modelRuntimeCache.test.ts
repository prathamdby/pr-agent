import { describe, expect, it, vi } from "vitest";
import { bindPromptCacheRetention } from "../src/agent/runtime/modelRuntimeCache.js";
import type { PromptCacheRuntime } from "../src/agent/runtime/modelRuntimeCache.js";

describe("bindPromptCacheRetention", () => {
  it("forwards short retention on all four ModelRuntime entry points", () => {
    const stream = vi.fn();
    const streamSimple = vi.fn();
    const complete = vi.fn();
    const completeSimple = vi.fn();
    const runtime: PromptCacheRuntime = {
      stream,
      streamSimple,
      complete,
      completeSimple,
    };

    bindPromptCacheRetention(runtime, "short");

    const model = { id: "m" };
    const context = { messages: [] };
    const callerOptions = { maxTokens: 7, cacheRetention: "long" };

    runtime.stream(model, context, callerOptions);
    runtime.streamSimple(model, context, callerOptions);
    runtime.complete(model, context, callerOptions);
    runtime.completeSimple(model, context, callerOptions);

    for (const spy of [stream, streamSimple, complete, completeSimple]) {
      expect(spy).toHaveBeenCalledWith(
        model,
        context,
        expect.objectContaining({ maxTokens: 7, cacheRetention: "short" }),
      );
    }
  });
});
