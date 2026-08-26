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
    setThinkingLevel: vi.fn(),
    dispose: vi.fn(),
  };
}

const createDefaultModelRuntimeMock = vi.hoisted(() => {
  return () => {
    const streamSimple = vi.fn((_model, _context, options) => ({
      options,
      result: async () => undefined,
    }));
    const stream = vi.fn((_model, _context, options) => ({
      options,
      result: async () => undefined,
    }));
    return {
      setRuntimeApiKey: vi.fn(async () => undefined),
      getError: vi.fn(() => undefined),
      getModel: vi.fn(() => ({
        id: "gpt-4o-mini",
        provider: "openai",
        api: "openai-responses",
      })),
      streamSimple,
      stream,
      completeSimple: vi.fn(async (model, context, options) =>
        streamSimple(model, context, options).result(),
      ),
      complete: vi.fn(async (model, context, options) => stream(model, context, options).result()),
    };
  };
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

import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { createAgentSession, defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunnerToolExecutor } from "../src/agent/providers/interface.js";
import {
  compactionPolicyForRole,
  createPiSession,
  DEFAULT_PROMPT_CACHE_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
  sessionCacheIdFromIdentity,
} from "../src/agent/runtime/piSession.js";
import type { Config } from "../src/config.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const cfg = makeTestConfig({
  modelProviderKeys: { openai: "test-key" },
  reviewConcurrency: 1,
  askConcurrency: 3,
});

const ASK_SEND_OPTS = { phase: "ask" as const, checkpointId: "test" };

async function createPiRunnerSession(params: {
  cfg: Config;
  cwd?: string;
  systemPrompt: string;
  tools: readonly PiTool[];
  executors: Record<string, AgentRunnerToolExecutor>;
}) {
  return createPiSession({
    role: "ask",
    primary: { provider: params.cfg.piProvider, model: params.cfg.piModel },
    thinkingPolicy: DEFAULT_THINKING_POLICY,
    compactionPolicy: compactionPolicyForRole("ask"),
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    structuredState: EMPTY_STRUCTURED_STATE,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink: () => undefined,
    cfg: params.cfg,
    tools: params.tools,
    executors: params.executors,
  });
}

describe("createPiSession models.json", () => {
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
      ...createDefaultModelRuntimeMock(),
      getError: () => undefined,
      getModel,
    } as never);

    await createPiRunnerSession({
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

    await createPiRunnerSession({
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
      createPiRunnerSession({
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

describe("createPiSession.send", () => {
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

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question", ASK_SEND_OPTS);
    expect(result.text).toBe("End-user summary and testing checklist.");
    expect(result.prompt).toEqual({
      inputCharacters: "question".length,
      inputBytes: Buffer.byteLength("question", "utf8"),
    });
    expect(result.usage).toBeUndefined();
  });

  it("shares one underlying abort across concurrent callers", async () => {
    let releaseAbort: (() => void) | undefined;
    const session = buildMockSession(() => undefined);
    session.abort = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseAbort = resolve;
        }),
    );
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const firstAbort = runnerSession.abort();
    const secondAbort = runnerSession.abort();
    expect(session.abort).toHaveBeenCalledTimes(1);

    releaseAbort?.();
    await expect(Promise.all([firstAbort, secondAbort])).resolves.toEqual([undefined, undefined]);
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

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question", ASK_SEND_OPTS);
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

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question", { ...ASK_SEND_OPTS, maxToolRounds: 2 });
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

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question", ASK_SEND_OPTS);
    expect(result.text).toBe("Visible answer.");
  });

  it("serializes object tool results as compact JSON", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    await createPiRunnerSession({
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
      subscribe: () => () => undefined,
      prompt: () => new Promise<void>(() => undefined),
      abort,
      setActiveToolsByName: vi.fn(),
      setThinkingLevel: vi.fn(),
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await createPiRunnerSession({
      cfg: { ...cfg, providerPromptTimeoutMs: 20 },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    await expect(runnerSession.send("question", ASK_SEND_OPTS)).rejects.toThrow(/timeout/i);
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
      setThinkingLevel: vi.fn(),
    };
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await createPiRunnerSession({
      cfg: { ...cfg, providerPromptTimeoutMs: 100 },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const sendPromise = runnerSession.send("question", ASK_SEND_OPTS);
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

    const runnerSession = await createPiRunnerSession({
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
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: vi.fn(),
      setActiveToolsByName: vi.fn(),
      setThinkingLevel: vi.fn(),
      dispose,
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await createPiRunnerSession({
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
      createPiRunnerSession({
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

describe("createPiSession prompt cache identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ModelRuntime.create).mockImplementation(
      async () => createDefaultModelRuntimeMock() as never,
    );
  });

  it("uses a stable SessionManager id for the same role and model", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    await createPiRunnerSession({
      cfg,
      cwd: "/tmp/pr-agent-cache-id",
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await createPiRunnerSession({
      cfg,
      cwd: "/tmp/pr-agent-cache-id",
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const expectedId = sessionCacheIdFromIdentity({
      role: "ask",
      provider: cfg.piProvider,
      model: cfg.piModel,
    });
    expect(SessionManager.inMemory).toHaveBeenCalledWith("/tmp/pr-agent-cache-id", {
      id: expectedId,
    });
    const ids = vi.mocked(SessionManager.inMemory).mock.calls.map((call) => call[1]?.id);
    expect(ids).toEqual([expectedId, expectedId]);
  });

  it("includes specialistId in the session cache identity", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    await createPiSession({
      role: "specialist",
      specialistId: "correctness",
      primary: { provider: cfg.piProvider, model: cfg.piModel },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: compactionPolicyForRole("specialist"),
      promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
      structuredState: EMPTY_STRUCTURED_STATE,
      systemPrompt: "specialist",
      cwd: "/tmp/pr-agent-specialist-cache",
      eventSink: () => undefined,
      cfg,
      tools: [],
      executors: {},
    });

    expect(SessionManager.inMemory).toHaveBeenCalledWith("/tmp/pr-agent-specialist-cache", {
      id: sessionCacheIdFromIdentity({
        role: "specialist",
        specialistId: "correctness",
        provider: cfg.piProvider,
        model: cfg.piModel,
      }),
    });
  });

  it("injects short cacheRetention on ModelRuntime stream entry", async () => {
    const runtime = createDefaultModelRuntimeMock();
    const originalStreamSimple = runtime.streamSimple;
    vi.mocked(ModelRuntime.create).mockResolvedValue(runtime as never);
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    // After bindPromptCacheRetention, streamSimple is replaced; call the bound method.
    runtime.streamSimple({ id: "m" }, { messages: [] }, { maxTokens: 1 });
    expect(originalStreamSimple).toHaveBeenCalledWith(
      { id: "m" },
      { messages: [] },
      expect.objectContaining({ cacheRetention: "short", maxTokens: 1 }),
    );
  });

  it("binds short retention and fallback cache id on restartWithFallback", async () => {
    const primaryRuntime = createDefaultModelRuntimeMock();
    const fallbackRuntime = createDefaultModelRuntimeMock();
    const primaryStreamSimple = primaryRuntime.streamSimple;
    const fallbackStreamSimple = fallbackRuntime.streamSimple;
    vi.mocked(ModelRuntime.create)
      .mockResolvedValueOnce(primaryRuntime as never)
      .mockResolvedValueOnce(fallbackRuntime as never);

    const primarySession = buildMockSession(() => undefined);
    const fallbackSession = buildMockSession(() => undefined);
    vi.mocked(createAgentSession)
      .mockResolvedValueOnce({ session: primarySession } as never)
      .mockResolvedValueOnce({ session: fallbackSession } as never);

    const session = await createPiSession({
      role: "ask",
      primary: { provider: "openai", model: "gpt-4o-mini" },
      fallback: { provider: "openai", model: "gpt-4o" },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: compactionPolicyForRole("ask"),
      promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
      structuredState: EMPTY_STRUCTURED_STATE,
      systemPrompt: "test",
      cwd: "/tmp/pr-agent-fallback-cache",
      eventSink: () => undefined,
      cfg,
      tools: [],
      executors: {},
    });

    await session.restartWithFallback({
      checkpointId: "ask:ask",
      structuredState: EMPTY_STRUCTURED_STATE,
    });

    const fallbackId = sessionCacheIdFromIdentity({
      role: "ask",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(SessionManager.inMemory).toHaveBeenLastCalledWith("/tmp/pr-agent-fallback-cache", {
      id: fallbackId,
    });

    fallbackRuntime.streamSimple({ id: "m" }, { messages: [] }, { maxTokens: 2 });
    expect(fallbackStreamSimple).toHaveBeenCalledWith(
      { id: "m" },
      { messages: [] },
      expect.objectContaining({ cacheRetention: "short", maxTokens: 2 }),
    );
    expect(primaryStreamSimple).not.toHaveBeenCalled();
  });
});
