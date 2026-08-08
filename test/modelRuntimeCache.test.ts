import { describe, expect, it, vi } from "vitest";
import { bindPromptCacheRetention } from "../src/agent/runtime/modelRuntimeCache.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

describe("bindPromptCacheRetention", () => {
  it("forwards short retention on all four ModelRuntime entry points", () => {
    const stream = vi.fn();
    const streamSimple = vi.fn();
    const complete = vi.fn();
    const completeSimple = vi.fn();
    const runtime = {
      stream,
      streamSimple,
      complete,
      completeSimple,
    } as unknown as ModelRuntime;

    bindPromptCacheRetention(runtime, "short");

    const model = { id: "m" };
    const context = { messages: [] };
    const callerOptions = { maxTokens: 7, cacheRetention: "long" as const };

    runtime.stream(model as never, context as never, callerOptions as never);
    runtime.streamSimple(model as never, context as never, callerOptions as never);
    runtime.complete(model as never, context as never, callerOptions as never);
    runtime.completeSimple(model as never, context as never, callerOptions as never);

    for (const spy of [stream, streamSimple, complete, completeSimple]) {
      expect(spy).toHaveBeenCalledWith(
        model,
        context,
        expect.objectContaining({ maxTokens: 7, cacheRetention: "short" }),
      );
    }
  });
});
