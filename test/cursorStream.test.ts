import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, CursorAgentError } from "@cursor/sdk";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import { streamCursor } from "../src/agent/providers/cursor/streamCursor.js";
import { attachCursorRunContext } from "../src/agent/providers/cursor/runContext.js";
import { getCursorModel, toCursorSdkModelSelection } from "../src/agent/providers/cursor/models.js";
import {
  CURSOR_RUN_ERROR_PREFIX,
  CURSOR_STARTUP_ERROR_PREFIX,
} from "../src/agent/providers/cursor/errors.js";
import type { Context } from "@earendil-works/pi-ai";

const composerModel = {
  id: "composer-2.5",
  displayName: "Composer 2.5",
  parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
};
setCursorModelsForTests([composerModel]);
const model = getCursorModel("composer-2.5");

function baseContext(): Context {
  return {
    systemPrompt: "Review system prompt",
    messages: [
      {
        role: "user",
        content: "Review this pull request",
        timestamp: Date.now(),
      },
    ],
    tools: [{ name: "noop", description: "noop", parameters: { type: "object" } }],
  };
}

function attachExecutors(context: Context): void {
  attachCursorRunContext(context, {
    executors: { noop: async () => "ok" },
    apiKey: "cursor_test_key",
    sdkModelSelection: toCursorSdkModelSelection("composer-2.5"),
  });
}

describe("streamCursor", () => {
  beforeEach(() => {
    vi.mocked(Agent.create).mockReset();
    setCursorModelsForTests([composerModel]);
  });

  afterEach(() => {
    resetCursorModelCapabilitiesForTests();
  });

  it("returns done message with approximate usage", async () => {
    vi.mocked(Agent.create).mockImplementation(async () => {
      const run = {
        cancel: vi.fn(),
        wait: vi.fn().mockResolvedValue({
          status: "completed",
          result: "Final review summary",
          id: "run-1",
        }),
      };
      return {
        send: vi.fn(async (_prompt, opts) => {
          opts?.onDelta?.({ update: { type: "text-delta", text: "Partial " } });
          return run;
        }),
        [Symbol.asyncDispose]: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof Agent.create>>;
    });

    const context = baseContext();
    attachExecutors(context);
    const result = await streamCursor(model, context, {
      apiKey: "cursor_test_key",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(
      result.content.some(
        (block) => block.type === "text" && block.text.includes("Final review summary"),
      ),
    ).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("sends only the latest user message on reused-agent follow-up sends", async () => {
    const sendMock = vi.fn(async (_prompt, opts) => {
      opts?.onDelta?.({ update: { type: "text-delta", text: "Follow-up answer" } });
      return {
        cancel: vi.fn(),
        wait: vi.fn().mockResolvedValue({
          status: "completed",
          result: "Follow-up answer",
          id: "run-2",
        }),
      };
    });
    const context: Context = {
      systemPrompt: "Review system prompt",
      messages: [
        {
          role: "user",
          content: "Review this pull request",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Initial answer" }],
          api: "cursor-sdk",
          provider: "cursor",
          model: "composer-2.5",
          usage: {
            input: 4,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 8,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
        {
          role: "user",
          content: "Repair the inline comments",
          timestamp: 3,
        },
      ],
      tools: [],
    };
    attachCursorRunContext(context, {
      executors: {},
      apiKey: "cursor_test_key",
      sdkModelSelection: toCursorSdkModelSelection("composer-2.5"),
      agent: {
        send: sendMock,
        [Symbol.asyncDispose]: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof Agent.create>>,
    });

    const result = await streamCursor(model, context, {
      apiKey: "cursor_test_key",
    }).result();

    expect(Agent.create).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toEqual({ text: "Repair the inline comments" });
    expect(result.usage.input).toBe(Math.ceil("Repair the inline comments".length / 4));
  });

  it("maps CursorAgentError to cursor_startup_error", async () => {
    vi.mocked(Agent.create).mockRejectedValue(
      new CursorAgentError("auth failed", { isRetryable: true }),
    );

    const context = baseContext();
    attachExecutors(context);
    const result = await streamCursor(model, context, {
      apiKey: "cursor_test_key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(CURSOR_STARTUP_ERROR_PREFIX);
    expect(result.errorMessage).toContain("auth failed");
  });

  it("maps run error status to cursor_run_error", async () => {
    vi.mocked(Agent.create).mockImplementation(async () => {
      const run = {
        cancel: vi.fn(),
        wait: vi.fn().mockResolvedValue({
          status: "error",
          id: "run-err-9",
          result: null,
        }),
      };
      return {
        send: vi.fn(async () => run),
        [Symbol.asyncDispose]: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof Agent.create>>;
    });

    const context = baseContext();
    attachExecutors(context);
    const result = await streamCursor(model, context, {
      apiKey: "cursor_test_key",
    }).result();

    expect(result.errorMessage).toBe(`${CURSOR_RUN_ERROR_PREFIX} run-err-9`);
  });

  it("returns aborted when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const context = baseContext();
    attachExecutors(context);
    const result = await streamCursor(model, context, {
      apiKey: "cursor_test_key",
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
  });
});
