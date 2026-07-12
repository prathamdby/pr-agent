import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import { Agent } from "@cursor/sdk";
import { makeTestConfig } from "./helpers/config.js";

const completeMock = vi.hoisted(() =>
  vi.fn(
    async (
      _model: unknown,
      context: { messages: unknown[]; systemPrompt?: string },
      _options?: { signal?: AbortSignal },
    ) => {
      const lastUser = [...context.messages].toReversed().find((message) => {
        return (
          typeof message === "object" &&
          message != null &&
          "role" in message &&
          (message as { role: string }).role === "user"
        );
      }) as { content: string } | undefined;
      const promptText = lastUser?.content ?? "";
      const inputChars =
        context.messages.length === 1
          ? (context.systemPrompt?.length ?? 0) + promptText.length + 10
          : promptText.length;
      return {
        role: "assistant",
        content: [{ type: "text", text: `answer ${context.messages.length}` }],
        usage: {
          input: Math.ceil(inputChars / 4),
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: Math.ceil(inputChars / 4) + 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
    },
  ),
);
const bridgeDisposeMock = vi.hoisted(() => vi.fn(async () => undefined));
const createMcpBridgeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    mcpServers: { test: { type: "http", url: "http://127.0.0.1" } },
    dispose: bridgeDisposeMock,
  })),
);

vi.mock("@earendil-works/pi-ai", () => ({
  complete: completeMock,
}));

vi.mock("../src/agent/providers/cursor/mcpBridge.js", () => ({
  createMcpBridge: createMcpBridgeMock,
}));

import { cursorAgentRunnerProvider } from "../src/agent/providers/cursor/agentRunner.js";

const cfg = makeTestConfig({
  agentProvider: "cursor",
  cursorApiKey: "cursor-key",
  piModel: "auto",
});

describe("cursorAgentRunnerProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCursorModelsForTests([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
      { id: "auto", displayName: "Auto" },
    ]);
  });

  afterEach(() => {
    resetCursorModelCapabilitiesForTests();
  });

  it("rejects session creation when its signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("review superseded"));

    await expect(
      cursorAgentRunnerProvider.createSession({
        cfg,
        systemPrompt: "system",
        tools: [],
        executors: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("review superseded");
    expect(Agent.create).not.toHaveBeenCalled();
  });

  it("passes explicit fast=false for composer-2.5", async () => {
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg: { ...cfg, piModel: "composer-2.5" },
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    await session.dispose();

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "false" }],
        },
      }),
    );
  });

  it("passes fast=true for gpt-5.5-fast", async () => {
    setCursorModelsForTests([
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
    ]);
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg: { ...cfg, piModel: "gpt-5.5-fast" },
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    await session.dispose();

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "gpt-5.5",
          params: [{ id: "fast", value: "true" }],
        },
      }),
    );
  });

  it("passes fast=true only for composer-2.5-fast", async () => {
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg: { ...cfg, piModel: "composer-2.5-fast" },
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    await session.dispose();

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "true" }],
        },
      }),
    );
  });

  it("reuses one MCP bridge and Cursor Agent across session sends", async () => {
    const agentDispose = vi.fn(async () => undefined);
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: agentDispose,
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
    });

    await expect(session.send("one")).resolves.toMatchObject({
      text: "answer 1",
      prompt: {
        inputCharacters: expect.any(Number),
        inputBytes: expect.any(Number),
      },
      usage: {
        estimated: true,
        inputTokens: expect.any(Number),
        outputTokens: 4,
        totalTokens: expect.any(Number),
      },
    });
    await expect(session.send("two")).resolves.toMatchObject({
      text: "answer 3",
      prompt: {
        inputCharacters: 3,
        inputBytes: 3,
      },
      usage: {
        estimated: true,
        inputTokens: 1,
        outputTokens: 4,
      },
    });
    await session.dispose();

    expect(createMcpBridgeMock).toHaveBeenCalledTimes(1);
    expect(Agent.create).toHaveBeenCalledTimes(1);
    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "auto" },
      }),
    );
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(agentDispose).toHaveBeenCalledTimes(1);
    expect(bridgeDisposeMock).toHaveBeenCalledTimes(1);
  });

  it("forwards send cancellation to the Cursor completion", async () => {
    let capturedSignal: AbortSignal | undefined;
    completeMock.mockImplementationOnce(
      async (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    );
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);
    const session = await cursorAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    const controller = new AbortController();

    const sendPromise = session.send("one", { signal: controller.signal });
    controller.abort(new Error("review superseded"));

    await expect(sendPromise).rejects.toThrow("review superseded");
    expect(capturedSignal?.aborted).toBe(true);
    await expect(session.send("follow-up")).resolves.toMatchObject({ text: "answer 2" });
    await session.dispose();
  });

  it("exposes provider-neutral session cancellation", async () => {
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);
    const session = await cursorAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
    });

    await session.cancel();

    await expect(session.send("one")).rejects.toMatchObject({ name: "AbortError" });
    await session.dispose();
  });
});
