import { access, constants } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

type MockTurnEndEvent = {
  type: "turn_end";
  toolResults: unknown[];
  message: {
    role: "assistant";
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }
    >;
  };
};

function makeAssistantMessage(text: string): MockTurnEndEvent["message"] {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function buildMockSession(script: (emit: (event: MockTurnEndEvent) => void) => void) {
  const listeners = new Set<(event: MockTurnEndEvent) => void>();
  return {
    subscribe(listener: (event: MockTurnEndEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      script((event) => {
        for (const listener of listeners) listener(event);
      });
    },
    abort: vi.fn(),
    setActiveToolsByName: vi.fn(),
    dispose: vi.fn(),
  };
}

const createDefaultModelRuntimeMock = vi.hoisted(() => {
  return () => ({
    setRuntimeApiKey: vi.fn(async () => undefined),
    getError: vi.fn(() => undefined),
    getModel: vi.fn(() => ({
      id: "gpt-4o-mini",
      provider: "openai",
      api: "openai-responses",
    })),
  });
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async () => createDefaultModelRuntimeMock()),
  },
  createAgentSession: vi.fn(),
  createExtensionRuntime: vi.fn(),
  defineTool: vi.fn((tool: unknown) => tool),
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader() {
    return { reload: vi.fn(async () => undefined) };
  }),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

import { createAgentSession, defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAgentRunnerProvider } from "../src/agent/providers/pi/index.js";

const cfg = makeTestConfig({
  modelProviderKeys: { openai: "test-key" },
  reviewConcurrency: 1,
  askConcurrency: 3,
});

describe("piAgentRunnerProvider.createSession models.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ModelRuntime.create).mockImplementation(
      async () => createDefaultModelRuntimeMock() as never,
    );
  });

  it("uses ModelRuntime with modelsJsonPath when set", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);
    const getModel = vi.fn(() => ({
      id: "llama3.1:8b",
      provider: "ollama",
      api: "openai-completions",
    }));
    vi.mocked(ModelRuntime.create).mockResolvedValue({
      setRuntimeApiKey: vi.fn(async () => undefined),
      getError: () => undefined,
      getModel,
    } as never);

    await piAgentRunnerProvider.createSession({
      cfg: makeTestConfig({
        modelsJsonPath: "/app/models.json",
        piProvider: "ollama",
        piModel: "llama3.1:8b",
        piApi: "openai-completions",
        modelProviderKeys: { openai: "test-key" },
      }),
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    expect(ModelRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({ modelsPath: "/app/models.json" }),
    );
    expect(getModel).toHaveBeenCalledWith("ollama", "llama3.1:8b");
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "llama3.1:8b", provider: "ollama", api: "openai-completions" },
      }),
    );
  });

  it("uses ModelRuntime with null modelsPath when modelsJsonPath is null", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    expect(ModelRuntime.create).toHaveBeenCalledWith(expect.objectContaining({ modelsPath: null }));
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "gpt-4o-mini", provider: "openai", api: "openai-responses" },
      }),
    );
  });

  it("throws when models.json runtime reports a load error", async () => {
    vi.mocked(ModelRuntime.create).mockResolvedValue({
      setRuntimeApiKey: vi.fn(async () => undefined),
      getError: () => "Invalid models.json schema",
      getModel: vi.fn(),
    } as never);

    await expect(
      piAgentRunnerProvider.createSession({
        cfg: makeTestConfig({
          modelsJsonPath: "/app/models.json",
          piProvider: "ollama",
          piModel: "llama3.1:8b",
          modelProviderKeys: { openai: "test-key" },
        }),
        systemPrompt: "test",
        tools: [],
        executors: {},
      }),
    ).rejects.toThrow(/Invalid models\.json schema/);
  });
});

describe("piAgentRunnerProvider.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ModelRuntime.create).mockImplementation(
      async () => createDefaultModelRuntimeMock() as never,
    );
  });

  it("returns terminal answer-turn text and ignores commentary from tool-using turns", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistantMessage("I'll examine the PR.Now let me check files."),
      });
      emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistantMessage("End-user summary and testing checklist."),
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question");
    expect(result.text).toBe("End-user summary and testing checklist.");
    expect(result.prompt).toEqual({
      inputCharacters: "question".length,
      inputBytes: Buffer.byteLength("question", "utf8"),
    });
    expect(result.usage).toBeUndefined();
  });

  it("returns exact usage when mocked turn events include provider token data", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [],
        message: {
          ...makeAssistantMessage("Final answer."),
          usage: {
            input: 20,
            output: 8,
            cacheRead: 5,
            cacheWrite: 0,
            totalTokens: 28,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question");
    expect(result.usage).toEqual({
      estimated: false,
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      totalTokens: 28,
    });
  });

  it("returns empty text when aborted before a terminal answer turn", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistantMessage("I'll examine the PR."),
      });
      emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistantMessage("Let me check more files."),
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question", { maxToolRounds: 2 });
    expect(result.text).toBe("");
    expect(session.abort).toHaveBeenCalled();
  });

  it("returns only text parts from a terminal turn with mixed content", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [],
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "Visible answer." },
            {
              type: "toolCall",
              id: "tc1",
              name: "listPullRequestFiles",
              arguments: {},
            },
          ],
        },
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question");
    expect(result.text).toBe("Visible answer.");
  });

  it("serializes object tool results as compact JSON", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [{ name: "object", description: "object", parameters: { type: "object" } }],
      executors: { object: async () => ({ answer: 42, nested: { ok: true } }) },
    });

    const tool = vi.mocked(defineTool).mock.calls.at(-1)?.[0];
    expect(tool).toBeDefined();
    if (!tool) throw new Error("expected Pi tool");
    await expect(
      tool.execute("tool-call-id", {}, undefined, undefined, {} as ExtensionContext),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: '{"answer":42,"nested":{"ok":true}}' }],
    });
  });

  it("aborts and rejects when a prompt exceeds the configured timeout", async () => {
    const abort = vi.fn();
    const session = {
      subscribe: () => () => {},
      prompt: () => new Promise<void>(() => {}),
      abort,
      setActiveToolsByName: vi.fn(),
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg: { ...cfg, providerPromptTimeoutMs: 20 },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    await expect(runnerSession.send("question")).rejects.toThrow(/timeout/i);
    expect(abort).toHaveBeenCalled();
  });

  it("does not abort while the provider keeps streaming activity within the idle window", async () => {
    const abort = vi.fn();
    const listeners = new Set<(event: unknown) => void>();
    let resolvePrompt: (() => void) | undefined;
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
      abort,
      setActiveToolsByName: vi.fn(),
    };
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg: { ...cfg, providerPromptTimeoutMs: 100 },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const sendPromise = runnerSession.send("question");
      // Three activity bursts spanning > idle window, each arriving before it elapses.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(80);
        emit({ type: "message_update" });
      }
      emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistantMessage("Final answer."),
      });
      resolvePrompt?.();
      await expect(sendPromise).resolves.toEqual({
        text: "Final answer.",
        prompt: { inputCharacters: 8, inputBytes: 8 },
      });
      expect(abort).not.toHaveBeenCalled();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("calls SDK session.dispose before removing the agent directory", async () => {
    const dispose = vi.fn();
    const session = buildMockSession(() => undefined);
    session.dispose = dispose;
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const agentDir = vi.mocked(createAgentSession).mock.calls.at(-1)?.[0]?.agentDir;
    expect(typeof agentDir).toBe("string");
    if (typeof agentDir !== "string") throw new Error("expected agentDir");
    await expect(access(agentDir, constants.F_OK)).resolves.toBeUndefined();

    await runnerSession.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(access(agentDir, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the agent directory even when SDK dispose throws", async () => {
    const dispose = vi.fn(() => {
      throw new Error("sdk dispose failed");
    });
    const session = {
      subscribe: () => () => {},
      prompt: async () => undefined,
      abort: vi.fn(),
      setActiveToolsByName: vi.fn(),
      dispose,
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const agentDir = vi.mocked(createAgentSession).mock.calls.at(-1)?.[0]?.agentDir;
    expect(typeof agentDir).toBe("string");
    if (typeof agentDir !== "string") throw new Error("expected agentDir");

    await expect(runnerSession.dispose()).rejects.toThrow("sdk dispose failed");
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(access(agentDir, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes agentDir with credentials when createSession setup fails", async () => {
    vi.mocked(createAgentSession).mockRejectedValue(new Error("session setup failed"));

    await expect(
      piAgentRunnerProvider.createSession({
        cfg,
        systemPrompt: "test",
        tools: [],
        executors: {},
      }),
    ).rejects.toThrow("session setup failed");

    const agentDir = vi.mocked(createAgentSession).mock.calls.at(-1)?.[0]?.agentDir;
    expect(typeof agentDir).toBe("string");
    if (typeof agentDir !== "string") throw new Error("expected agentDir");
    await expect(access(agentDir, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
