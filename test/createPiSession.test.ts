import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

type LoopEmit = (event: {
  type: string;
  toolName?: string;
  toolResults?: unknown[];
  message?: {
    role: "assistant";
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    };
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >;
  };
}) => void | Promise<void>;

function makeAssistant(
  text: string,
  extras: {
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    };
    content?: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >;
  } = {},
) {
  return {
    role: "assistant" as const,
    content: extras.content ?? [{ type: "text" as const, text }],
    stopReason: extras.stopReason,
    errorMessage: extras.errorMessage,
    usage: extras.usage,
  };
}

function makeProviderErrorTurn(
  errorMessage: string,
  extras: { usage?: NonNullable<ReturnType<typeof makeAssistant>["usage"]> } = {},
) {
  return {
    type: "turn_end" as const,
    toolResults: [] as unknown[],
    message: makeAssistant("", {
      stopReason: "error",
      errorMessage,
      ...extras,
    }),
  };
}

const runAgentLoop = vi.hoisted(() => vi.fn());
const runAgentLoopContinue = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    runAgentLoop,
    runAgentLoopContinue,
  };
});

import type { Tool as PiTool } from "@earendil-works/pi-ai";
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
import { toCoreTool } from "../src/agent/runtime/coreTools.js";
import { createSessionStreamFn } from "../src/agent/runtime/sessionStream.js";
import type { Config } from "../src/config.js";

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
  eventSink?: (event: { kind: string; failureCode?: string }) => void;
  role?: "ask" | "orchestrator" | "specialist";
  specialistId?: string;
}) {
  return createPiSession({
    role: params.role ?? "ask",
    ...(params.specialistId ? { specialistId: params.specialistId } : {}),
    primary: { provider: params.cfg.piProvider, model: params.cfg.piModel },
    thinkingPolicy: DEFAULT_THINKING_POLICY,
    compactionPolicy: compactionPolicyForRole(params.role ?? "ask"),
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    structuredState: EMPTY_STRUCTURED_STATE,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink: params.eventSink ?? (() => undefined),
    cfg: params.cfg,
    tools: params.tools,
    executors: params.executors,
  });
}

function lastLoopConfig() {
  const call = runAgentLoop.mock.calls.at(-1);
  if (!call) throw new Error("expected runAgentLoop call");
  return call[2] as {
    model: { id: string; provider: string; api: string };
    sessionId?: string;
    cacheRetention?: string;
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
    prepareNextTurn?: unknown;
  };
}

function lastLoopContext() {
  const call = runAgentLoop.mock.calls.at(-1);
  if (!call) throw new Error("expected runAgentLoop call");
  return call[1] as {
    tools: Array<{
      name: string;
      executionMode?: string;
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<unknown>;
    }>;
  };
}

function lastLoopSignal() {
  const call = runAgentLoop.mock.calls.at(-1);
  if (!call) throw new Error("expected runAgentLoop call");
  return call[4] as AbortSignal | undefined;
}

function mockSuccessfulLoop(text = "ok") {
  runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
    await emit({
      type: "turn_end",
      toolResults: [],
      message: makeAssistant(text, { stopReason: "stop" }),
    });
    return [];
  });
}

describe("createPiSession models.json", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-agent-session-models-"));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSuccessfulLoop();
  });

  it("resolves a custom catalog model when modelsJsonPath is set", async () => {
    const path = join(tempDir(), "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            api: "openai-completions",
            apiKey: "ollama",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
    );
    const session = await createPiRunnerSession({
      cfg: makeTestConfig({
        modelsJsonPath: path,
        piProvider: "ollama",
        piModel: "llama3.1:8b",
        piApi: "openai-completions",
        modelProviderKeys: { openai: "test-key" },
      }),
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await session.send("question", ASK_SEND_OPTS);
    expect(lastLoopConfig().model).toMatchObject({
      id: "llama3.1:8b",
      provider: "ollama",
      api: "openai-completions",
    });
  });

  it("resolves the built-in model when modelsJsonPath is null", async () => {
    const session = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await session.send("question", ASK_SEND_OPTS);
    expect(lastLoopConfig().model).toMatchObject({
      id: "gpt-4o-mini",
      provider: "openai",
      api: "openai-responses",
    });
  });

  it("throws when models.json schema is invalid", async () => {
    const path = join(tempDir(), "models.json");
    writeFileSync(path, JSON.stringify({ providers: "nope" }));
    await expect(
      createPiRunnerSession({
        cfg: makeTestConfig({
          modelsJsonPath: path,
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
    mockSuccessfulLoop();
  });

  it("returns terminal answer-turn text and ignores commentary from tool-using turns", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistant("I'll examine the PR.Now let me check files."),
      });
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("End-user summary and testing checklist."),
      });
      return [];
    });
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
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const firstAbort = runnerSession.abort();
    const secondAbort = runnerSession.abort();
    await expect(Promise.all([firstAbort, secondAbort])).resolves.toEqual([undefined, undefined]);
  });

  it("returns exact usage when mocked turn events include provider token data", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("Final answer.", {
          usage: {
            input: 20,
            output: 8,
            cacheRead: 5,
            cacheWrite: 0,
            totalTokens: 28,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      });
      return [];
    });
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

  it("returns empty text when the tool-round budget stops before a terminal answer", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistant("I'll examine the PR."),
      });
      await emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistant("Let me check more files."),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const result = await runnerSession.send("question", { ...ASK_SEND_OPTS, maxToolRounds: 2 });
    expect(result.text).toBe("");
  });

  it("returns only text parts from a terminal turn with mixed content", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("Visible answer.", {
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "Visible answer." },
            { type: "toolCall", id: "tc1", name: "listPullRequestFiles", arguments: {} },
          ],
        }),
      });
      return [];
    });
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
    const tool = toCoreTool(
      { name: "object", description: "object", parameters: { type: "object" } },
      async () => ({ answer: 42, nested: { ok: true } }),
      undefined,
    );
    await expect(tool.execute("tool-call-id", {}, undefined)).resolves.toMatchObject({
      content: [{ type: "text", text: '{"answer":42,"nested":{"ok":true}}' }],
    });
  });

  it("aborts and rejects when a prompt exceeds the configured timeout", async () => {
    runAgentLoop.mockImplementation(
      (_prompts, _context, _config, _emit: LoopEmit, signal?: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const runnerSession = await createPiRunnerSession({
      cfg: { ...cfg, providerPromptTimeoutMs: 20 },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await expect(runnerSession.send("question", ASK_SEND_OPTS)).rejects.toThrow(/timeout/i);
  });

  it("does not abort while the provider keeps streaming activity within the idle window", async () => {
    let loopEmit: LoopEmit | undefined;
    let resolveLoop: (() => void) | undefined;
    runAgentLoop.mockImplementation((_prompts, _context, _config, emit: LoopEmit) => {
      loopEmit = emit;
      return new Promise<never[]>((resolve) => {
        resolveLoop = () => resolve([]);
      });
    });
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
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(80);
        await loopEmit?.({ type: "message_update" });
      }
      await loopEmit?.({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("Final answer."),
      });
      resolveLoop?.();
      await expect(sendPromise).resolves.toEqual({
        text: "Final answer.",
        prompt: { inputCharacters: 8, inputBytes: 8 },
      });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("terminates a send aborted while waiting on the loop signal", async () => {
    const retrySleepFired = vi.fn();
    runAgentLoop.mockImplementation(
      (_prompts, _context, _config, _emit: LoopEmit, signal?: AbortSignal) =>
        new Promise<never[]>((_, reject) => {
          const rejectOnAbort = () =>
            reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
          signal?.addEventListener("abort", rejectOnAbort, { once: true });
          const retryTimer = setTimeout(() => {
            retrySleepFired();
          }, 2000);
          signal?.addEventListener("abort", () => clearTimeout(retryTimer), { once: true });
        }),
    );
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    vi.useFakeTimers();
    try {
      const sendPromise = runnerSession.send("question", ASK_SEND_OPTS);
      await vi.advanceTimersByTimeAsync(1000);
      expect(retrySleepFired).not.toHaveBeenCalled();
      await runnerSession.abort();
      await expect(sendPromise).rejects.toMatchObject({ code: "agent.session_aborted" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(retrySleepFired).not.toHaveBeenCalled();
      expect(lastLoopSignal()?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createPiSession terminal provider outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuccessfulLoop();
  });

  it("rejects a resolved prompt that ends on an assistant error", async () => {
    const events: Array<{ kind: string; failureCode?: string }> = [];
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit(makeProviderErrorTurn("429 Too Many Requests: rate limit exceeded"));
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
      eventSink: (event) => events.push(event),
    });
    await expect(runnerSession.send("question", ASK_SEND_OPTS)).rejects.toMatchObject({
      code: "provider.request_failed",
      message: "429 Too Many Requests: rate limit exceeded",
    });
    expect(events.map((event) => event.kind)).toContain("failure");
    expect(events.map((event) => event.kind)).not.toContain("completion");
    expect(events.find((event) => event.kind === "failure")?.failureCode).toBe(
      "provider.request_failed",
    );
    expect(JSON.stringify(events)).not.toContain("429");
  });

  it("returns text after an error turn and a successful turn retry", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit(makeProviderErrorTurn("502 Bad Gateway"));
      return [];
    });
    runAgentLoopContinue.mockImplementation(async (_context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("recovered answer", { stopReason: "stop" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await expect(runnerSession.send("question", ASK_SEND_OPTS)).resolves.toMatchObject({
      text: "recovered answer",
    });
    expect(runAgentLoopContinue).toHaveBeenCalledTimes(1);
  });

  it("rejects after exhausted retry error turns", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit(makeProviderErrorTurn("502 Bad Gateway"));
      return [];
    });
    runAgentLoopContinue.mockImplementation(async (_context, _config, emit: LoopEmit) => {
      await emit(makeProviderErrorTurn("502 Bad Gateway"));
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await expect(runnerSession.send("question", ASK_SEND_OPTS)).rejects.toMatchObject({
      code: "provider.request_failed",
      message: "502 Bad Gateway",
    });
  });

  it("wraps a directly rejected loop promise", async () => {
    runAgentLoop.mockImplementation(async () => {
      throw new Error("401 Unauthorized invalid api key");
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await expect(runnerSession.send("question", ASK_SEND_OPTS)).rejects.toMatchObject({
      code: "provider.request_failed",
      message: "401 Unauthorized invalid api key",
    });
  });

  it("prefers public cancellation over a retained error turn", async () => {
    let resolveLoop: (() => void) | undefined;
    let loopEmit: LoopEmit | undefined;
    runAgentLoop.mockImplementation((_prompts, _context, _config, emit: LoopEmit) => {
      loopEmit = emit;
      return new Promise<never[]>((resolve) => {
        resolveLoop = () => resolve([]);
      });
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    const sendPromise = runnerSession.send("question", ASK_SEND_OPTS);
    await loopEmit?.(makeProviderErrorTurn("502 Bad Gateway"));
    await runnerSession.abort();
    resolveLoop?.();
    const error = await sendPromise.catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "agent.session_aborted" });
  });

  it("keeps tool-budget termination as a successful empty turn", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistant("I'll examine the PR.", { stopReason: "toolUse" }),
      });
      await emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistant("Let me check more files.", { stopReason: "toolUse" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await expect(
      runnerSession.send("question", { ...ASK_SEND_OPTS, maxToolRounds: 2 }),
    ).resolves.toMatchObject({ text: "" });
  });

  it("resets provider error state between successive sends", async () => {
    let sendCount = 0;
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      sendCount += 1;
      if (sendCount === 1) {
        await emit(makeProviderErrorTurn("502 Bad Gateway"));
        return [];
      }
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("second send ok", { stopReason: "stop" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await expect(runnerSession.send("first", ASK_SEND_OPTS)).rejects.toMatchObject({
      code: "provider.request_failed",
    });
    await expect(runnerSession.send("second", ASK_SEND_OPTS)).resolves.toMatchObject({
      text: "second send ok",
    });
  });

  it("keeps usage from error turns when the send later fails", async () => {
    const events: Array<{ kind: string }> = [];
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit(
        makeProviderErrorTurn("502 Bad Gateway", {
          usage: {
            input: 11,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 14,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      );
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
      eventSink: (event) => events.push({ kind: event.kind }),
    });
    const error = await runnerSession
      .send("question", ASK_SEND_OPTS)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "provider.request_failed" });
    expect(events.map((event) => event.kind)).toContain("usage");
  });
});

describe("createPiSession prompt cache identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuccessfulLoop();
  });

  it("uses a stable session id for the same role and model", async () => {
    const session = await createPiRunnerSession({
      cfg,
      cwd: "/tmp/pr-agent-cache-id",
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await session.send("question", ASK_SEND_OPTS);
    const expectedId = sessionCacheIdFromIdentity({
      role: "ask",
      provider: cfg.piProvider,
      model: cfg.piModel,
    });
    expect(lastLoopConfig().sessionId).toBe(expectedId);
    const second = await createPiRunnerSession({
      cfg,
      cwd: "/tmp/pr-agent-cache-id",
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await second.send("question", ASK_SEND_OPTS);
    expect(lastLoopConfig().sessionId).toBe(expectedId);
  });

  it("includes specialistId in the session cache identity", async () => {
    const session = await createPiSession({
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
    await session.send("run", { phase: "specialist", checkpointId: "cp" });
    expect(lastLoopConfig().sessionId).toBe(
      sessionCacheIdFromIdentity({
        role: "specialist",
        specialistId: "correctness",
        provider: cfg.piProvider,
        model: cfg.piModel,
      }),
    );
  });

  it("injects short cacheRetention on the loop config", async () => {
    const session = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await session.send("question", ASK_SEND_OPTS);
    expect(lastLoopConfig()).toMatchObject({
      cacheRetention: "short",
      timeoutMs: cfg.providerPromptTimeoutMs,
    });
  });

  it("configures provider transport retry from validated config", async () => {
    const session = await createPiRunnerSession({
      cfg: {
        ...cfg,
        piProviderRetryMax: 4,
        piProviderMaxRetryDelayMs: 45_000,
      },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await session.send("question", ASK_SEND_OPTS);
    expect(lastLoopConfig()).toMatchObject({
      maxRetries: 4,
      maxRetryDelayMs: 45_000,
    });
  });

  it("disables provider transport retry when the retry count is zero", async () => {
    const session = await createPiRunnerSession({
      cfg: { ...cfg, piProviderRetryMax: 0 },
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await session.send("question", ASK_SEND_OPTS);
    expect(lastLoopConfig()).toMatchObject({
      maxRetries: 0,
      maxRetryDelayMs: 60_000,
    });
  });

  it("merges short cacheRetention onto streamSimple options", async () => {
    const streamSimple = vi.fn((_model, _context, options) => ({
      options,
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true as const, value: undefined }),
        };
      },
      result: async () => undefined,
    }));
    const { streamFn, getLastOptions } = createSessionStreamFn({ streamSimple } as never, {
      cacheRetention: "short",
      sessionId: "sess",
      timeoutMs: 12,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
    });
    await streamFn(
      { id: "m", provider: "openai", api: "openai-responses" } as never,
      { messages: [] },
      { maxTokens: 7, cacheRetention: "long" },
    );
    expect(getLastOptions()).toMatchObject({
      maxTokens: 7,
      cacheRetention: "short",
      sessionId: "sess",
      timeoutMs: 12,
      maxRetries: 2,
      maxRetryDelayMs: 1000,
    });
  });
});

describe("createPiSession tool contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuccessfulLoop();
  });

  it("marks execute and native mutation tools sequential and leaves reads unset", async () => {
    const session = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [
        { name: "execute", description: "run", parameters: { type: "object" } },
        { name: "listChangedFiles", description: "list", parameters: { type: "object" } },
        { name: "publish_summary", description: "publish", parameters: { type: "object" } },
      ],
      executors: {
        execute: async () => ({ ok: true }),
        listChangedFiles: async () => ({ files: [] }),
        publish_summary: async () => ({ accepted: true }),
      },
    });
    await session.send("question", ASK_SEND_OPTS);
    const defined = lastLoopContext().tools;
    expect(defined.find((tool) => tool.name === "execute")?.executionMode).toBe("sequential");
    expect(defined.find((tool) => tool.name === "publish_summary")?.executionMode).toBe(
      "sequential",
    );
    expect(defined.find((tool) => tool.name === "listChangedFiles")?.executionMode).toBeUndefined();
  });

  it("forwards the loop abort signal into the executor context", async () => {
    let seen: AbortSignal | undefined;
    const session = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [{ name: "execute", description: "run", parameters: { type: "object" } }],
      executors: {
        execute: async (_args, ctx) => {
          seen = ctx?.signal;
          return { ok: true };
        },
      },
    });
    await session.send("question", ASK_SEND_OPTS);
    const tool = lastLoopContext().tools.find((entry) => entry.name === "execute");
    const controller = new AbortController();
    controller.abort();
    await tool?.execute("tool-call-id", { code: "1" }, controller.signal);
    expect(seen?.aborted).toBe(true);
  });
});
