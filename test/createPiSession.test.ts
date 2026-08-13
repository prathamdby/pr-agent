import { access, constants } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import type { AgentRunnerToolExecutorMap } from "../src/agent/providers/interface.js";
import {
  compactionPolicyForRole,
  createPiSession,
  DEFAULT_PROMPT_CACHE_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
  resetPiSessionRuntime,
  sessionCacheIdFromIdentity,
  setPiSessionRuntime,
} from "../src/agent/runtime/piSession.js";
import type {
  PiDefinedTool,
  PiDefineToolInput,
  PiModelRuntime,
  PiSdkEvent,
  PiSdkSession,
  PiSdkTurnEndEvent,
  PiToolExecuteContext,
} from "../src/agent/runtime/piSession.js";
import type { Config } from "../src/config.js";
import { isJsonString } from "../src/util/jsonValue.js";
import { makeTestConfig } from "./helpers/config.js";

type MockTurnEndEvent = PiSdkTurnEndEvent;

function makeAssistantMessage(text: string): MockTurnEndEvent["message"] {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function buildMockSession(script: (emit: (event: PiSdkEvent) => void) => void): PiSdkSession {
  const listeners = new Set<(event: PiSdkEvent) => void>();
  return {
    subscribe(listener: (event: PiSdkEvent) => void) {
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

const createDefaultModelRuntimeMock = (): PiModelRuntime => {
  const streamSimple = vi.fn((_model, _context, options) => {
    void options;
  });
  const stream = vi.fn((_model, _context, options) => {
    void options;
  });
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
    completeSimple: vi.fn((model, context, options) => {
      streamSimple(model, context, options);
    }),
    complete: vi.fn((model, context, options) => {
      stream(model, context, options);
    }),
  };
};

const ModelRuntime = {
  create: vi.fn(async () => createDefaultModelRuntimeMock()),
};
const createAgentSession = vi.fn();
const defineTool = vi.fn((tool: PiDefineToolInput): PiDefinedTool => tool);
const DefaultResourceLoader = vi.fn(function DefaultResourceLoader() {
  return { reload: vi.fn(async () => undefined) };
});
type SessionManagerOptions = { readonly id?: string };
const SessionManager = {
  inMemory: vi.fn((_cwd: string, _options?: SessionManagerOptions) => ({})),
};
const SettingsManager = { inMemory: vi.fn(() => ({})) };
const createExtensionRuntime = vi.fn(() => ({}));

function installTestPiSessionRuntime(): void {
  setPiSessionRuntime({
    ModelRuntime,
    createAgentSession,
    createExtensionRuntime,
    defineTool,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
  });
}

afterEach(() => {
  resetPiSessionRuntime();
});

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
  executors: AgentRunnerToolExecutorMap;
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
    installTestPiSessionRuntime();
    vi.clearAllMocks();
    vi.mocked(ModelRuntime.create).mockImplementation(async () => createDefaultModelRuntimeMock());
  });

  it("uses ModelRuntime with modelsJsonPath when set", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session });
    const getModel = vi.fn(() => ({
      id: "llama3.1:8b",
      provider: "ollama",
      api: "openai-completions",
    }));
    vi.mocked(ModelRuntime.create).mockResolvedValue({
      ...createDefaultModelRuntimeMock(),
      getError: () => undefined,
      getModel,
    });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
      ...createDefaultModelRuntimeMock(),
      getError: () => "Invalid models.json schema",
      getModel: vi.fn(),
    });

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
    installTestPiSessionRuntime();
    vi.clearAllMocks();
    vi.mocked(ModelRuntime.create).mockImplementation(async () => createDefaultModelRuntimeMock());
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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

    await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [{ name: "object", description: "object", parameters: { type: "object" } }],
      executors: { object: async () => ({ answer: 42, nested: { ok: true } }) },
    });

    const tool = defineTool.mock.calls.at(-1)?.[0];
    expect(tool).toBeDefined();
    if (!tool) throw new Error("expected Pi tool");
    await expect(
      tool.execute("tool-call-id", {}, undefined, undefined, {} satisfies PiToolExecuteContext),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: '{"answer":42,"nested":{"ok":true}}' }],
    });
  });

  it("aborts and rejects when a prompt exceeds the configured timeout", async () => {
    const abort = vi.fn();
    const session: PiSdkSession = {
      subscribe: () => () => {},
      prompt: () => new Promise<void>(() => {}),
      abort,
      setActiveToolsByName: vi.fn(),
      setThinkingLevel: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    const listeners = new Set<(event: PiSdkEvent) => void>();
    let resolvePrompt: (() => void) | undefined;
    const session: PiSdkSession = {
      subscribe(listener: (event: PiSdkEvent) => void) {
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
      dispose: vi.fn(),
    };
    const emit = (event: PiSdkEvent) => {
      for (const listener of listeners) listener(event);
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(createAgentSession).mockResolvedValue({ session });

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const agentDir = vi.mocked(createAgentSession).mock.calls.at(-1)?.[0]?.agentDir;
    expect(isJsonString(agentDir)).toBe(true);
    if (!isJsonString(agentDir)) throw new Error("expected agentDir");
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
      setThinkingLevel: vi.fn(),
      dispose,
    };
    vi.mocked(createAgentSession).mockResolvedValue({ session });

    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const agentDir = vi.mocked(createAgentSession).mock.calls.at(-1)?.[0]?.agentDir;
    expect(isJsonString(agentDir)).toBe(true);
    if (!isJsonString(agentDir)) throw new Error("expected agentDir");

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
    expect(isJsonString(agentDir)).toBe(true);
    if (!isJsonString(agentDir)) throw new Error("expected agentDir");
    await expect(access(agentDir, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("createPiSession prompt cache identity", () => {
  beforeEach(() => {
    installTestPiSessionRuntime();
    vi.clearAllMocks();
    vi.mocked(ModelRuntime.create).mockImplementation(async () => createDefaultModelRuntimeMock());
  });

  it("uses a stable SessionManager id for the same role and model", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    const ids = SessionManager.inMemory.mock.calls.map((call) => call[1]?.id);
    expect(ids).toEqual([expectedId, expectedId]);
  });

  it("includes specialistId in the session cache identity", async () => {
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
    vi.mocked(ModelRuntime.create).mockResolvedValue(runtime);
    const session = buildMockSession(() => undefined);
    vi.mocked(createAgentSession).mockResolvedValue({ session });

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
      .mockResolvedValueOnce(primaryRuntime)
      .mockResolvedValueOnce(fallbackRuntime);

    const primarySession = buildMockSession(() => undefined);
    const fallbackSession = buildMockSession(() => undefined);
    vi.mocked(createAgentSession)
      .mockResolvedValueOnce({ session: primarySession })
      .mockResolvedValueOnce({ session: fallbackSession });

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
