import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeToolResult(toolCallId: string, toolName: string) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
}

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
  sessionCacheIdFromIdentity,
} from "../src/agent/runtime/piSession.js";
import { toCoreTool } from "../src/agent/runtime/coreTools.js";
import * as coreToolsModule from "../src/agent/runtime/coreTools.js";
import { createSessionStreamFn } from "../src/agent/runtime/sessionStream.js";
import type { ThinkingPolicy } from "../src/agent/runtime/types.js";
import { normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { isAppError } from "../src/errors/appError.js";
import type { Config } from "../src/settings/index.js";

const cfg = makeTestConfig({
  models: { providerKeys: { openai: "test-key" } },
  concurrency: { review: 1, ask: 3 },
});

const ASK_SEND_OPTS = { phase: "ask" as const, checkpointId: "test" };

async function createPiRunnerSession(params: {
  cfg: Config;
  cwd?: string;
  systemPrompt: string;
  tools: readonly PiTool[];
  executors: Record<string, AgentRunnerToolExecutor>;
  eventSink?: (event: {
    kind: string;
    failureCode?: string;
    end?: string;
    reason?: string;
    toolName?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  }) => void;
  role?: "ask" | "orchestrator" | "specialist";
  specialistId?: string;
  hostSignal?: AbortSignal;
  thinkingPolicy?: ThinkingPolicy;
}) {
  return createPiSession({
    role: params.role ?? "ask",
    ...(params.specialistId ? { specialistId: params.specialistId } : {}),
    primary: { provider: params.cfg.models.provider, model: params.cfg.models.model },
    thinkingPolicy: params.thinkingPolicy ?? DEFAULT_THINKING_POLICY,
    compactionPolicy: compactionPolicyForRole(params.role ?? "ask"),
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    systemPrompt: params.systemPrompt,
    cwd: params.cwd,
    eventSink: params.eventSink ?? (() => undefined),
    cfg: params.cfg,
    tools: params.tools,
    executors: params.executors,
    ...(params.hostSignal ? { hostSignal: params.hostSignal } : {}),
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
        models: {
          jsonPath: path,
          provider: "ollama",
          model: "llama3.1:8b",
          api: "openai-completions",
          providerKeys: { openai: "test-key" },
        },
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
          models: {
            jsonPath: path,
            provider: "ollama",
            model: "llama3.1:8b",
            providerKeys: { openai: "test-key" },
          },
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
    expect(result.end).toBe("completed");
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
    expect(result.end).toBe("tool_budget");
  });

  it("reports output_limit when the final assistant message stops on length", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("Partial answer that was cut", { stopReason: "length" }),
      });
      return [];
    });
    const events: Array<{ kind: string; end?: string }> = [];
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
      eventSink: (event) => events.push(event),
    });
    const result = await runnerSession.send("question", ASK_SEND_OPTS);
    expect(result).toMatchObject({ text: "Partial answer that was cut", end: "output_limit" });
    expect(events.find((event) => event.kind === "completion")).toMatchObject({
      end: "output_limit",
    });
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
      cfg: { ...cfg, provider: { ...cfg.provider, promptTimeoutMs: 20 } },
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
      cfg: { ...cfg, provider: { ...cfg.provider, promptTimeoutMs: 100 } },
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
        end: "completed",
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
    vi.useFakeTimers();
    try {
      const send = runnerSession.send("question", ASK_SEND_OPTS);
      await vi.advanceTimersByTimeAsync(250);
      await expect(send).resolves.toMatchObject({ text: "recovered answer" });
      expect(runAgentLoopContinue).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps tool results between the assistant turns that produced them", async () => {
    const rolesAtLoopStart: string[][] = [];
    runAgentLoop.mockImplementation(async (prompts, context, _config, emit: LoopEmit) => {
      const messages = (context as { messages: Array<{ role: string }> }).messages;
      rolesAtLoopStart.push(messages.map((message) => message.role));
      if (runAgentLoop.mock.calls.length === 1) {
        const user = (prompts as Array<{ role: string }>)[0];
        const first = makeAssistant("I'll look.", {
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "c1", name: "readFile", arguments: {} }],
        });
        const toolResult = makeToolResult("c1", "readFile");
        const second = makeAssistant("done", { stopReason: "stop" });
        await emit({
          type: "turn_end",
          toolResults: [{}],
          message: first,
        });
        await emit({
          type: "turn_end",
          toolResults: [],
          message: second,
        });
        return [user, first, toolResult, second];
      }
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("later", { stopReason: "stop" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await runnerSession.send("first", ASK_SEND_OPTS);
    await runnerSession.send("second", ASK_SEND_OPTS);
    expect(rolesAtLoopStart[1]).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
  });

  it("inserts each send prompt after prior assistant turns", async () => {
    const rolesAtLoopStart: string[][] = [];
    runAgentLoop.mockImplementation(async (_prompts, context, _config, emit: LoopEmit) => {
      const messages = (context as { messages: Array<{ role: string }> }).messages;
      rolesAtLoopStart.push(messages.map((message) => message.role));
      const n = runAgentLoop.mock.calls.length;
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant(`a${n}`, { stopReason: "stop" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await runnerSession.send("first", ASK_SEND_OPTS);
    await runnerSession.send("second", ASK_SEND_OPTS);
    await runnerSession.send("third", ASK_SEND_OPTS);
    expect(rolesAtLoopStart[1]).toEqual(["system", "user", "assistant"]);
    expect(rolesAtLoopStart[2]).toEqual(["system", "user", "assistant", "user", "assistant"]);
  });

  it("seeds the system prompt as the leading system message", async () => {
    let seen: Array<{ role: string; content?: unknown }> | undefined;
    runAgentLoop.mockImplementation(async (_prompts, context, _config, emit: LoopEmit) => {
      seen = (context as { messages: Array<{ role: string; content?: unknown }> }).messages;
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("ok", { stopReason: "stop" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await runnerSession.send("question", ASK_SEND_OPTS);
    expect(seen?.[0]).toMatchObject({ role: "system", content: "test" });
  });

  it("keeps the system prompt when converting the transcript for the provider", async () => {
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit: LoopEmit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistant("ok", { stopReason: "stop" }),
      });
      return [];
    });
    const runnerSession = await createPiRunnerSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });
    await runnerSession.send("question", ASK_SEND_OPTS);
    const config = runAgentLoop.mock.calls.at(-1)?.[2] as {
      convertToLlm: (messages: never) => Array<{ role: string }>;
    };
    const converted = config.convertToLlm([
      { role: "system", content: "sys", timestamp: Date.now() },
      { role: "user", content: "hi", timestamp: Date.now() },
      makeAssistant("answer", { stopReason: "stop" }),
      makeToolResult("c1", "readFile"),
    ] as never);
    expect(converted.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
    ]);
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
      provider: cfg.models.provider,
      model: cfg.models.model,
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
      primary: { provider: cfg.models.provider, model: cfg.models.model },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: compactionPolicyForRole("specialist"),
      promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
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
        provider: cfg.models.provider,
        model: cfg.models.model,
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
      timeoutMs: cfg.provider.promptTimeoutMs,
    });
  });

  it("configures provider transport retry from validated config", async () => {
    const session = await createPiRunnerSession({
      cfg: {
        ...cfg,
        provider: { ...cfg.provider, retryMax: 4, maxRetryDelayMs: 45_000 },
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
      cfg: { ...cfg, provider: { ...cfg.provider, retryMax: 0 } },
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
      normalizeContext({ messages: [] }),
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

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SYS_MARKER = "SYS_MARKER_9f3";
const THINK_MARKER = "THINK_MARKER_9f3";
const TOOL_MARKER = "TOOL_OK_9f3";
const FEDERATION_TOKEN = "federation-token-must-not-leak";
const EXPLICIT_LAB_KEY = "explicit-lab-key";
const EXPLICIT_ANTHROPIC_KEY = "explicit-anthropic-key";

type InspectedRequest = {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
  readonly labPolicy: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly thinkingType: string | undefined;
  readonly hasSummaryPrefix: boolean;
  readonly hasSystemMarker: boolean;
  readonly hasThinkingMarker: boolean;
  readonly hasToolMarker: boolean;
  readonly hasCheckpointPrompt: boolean;
  readonly sawFederationToken: boolean;
};

type Loopback = {
  readonly origin: string;
  readonly requests: InspectedRequest[];
  close: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includesMarker(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some((entry) => includesMarker(entry, marker));
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => includesMarker(entry, marker));
}

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function inspectRequest(
  path: string,
  headers: IncomingMessage["headers"],
  body: unknown,
): InspectedRequest {
  const authorization = headerValue(headers, "authorization");
  const apiKey = headerValue(headers, "x-api-key");
  const effort =
    isRecord(body) && isRecord(body.output_config) && typeof body.output_config.effort === "string"
      ? body.output_config.effort
      : undefined;
  const thinkingType =
    isRecord(body) && isRecord(body.thinking) && typeof body.thinking.type === "string"
      ? body.thinking.type
      : undefined;
  const model = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
  return {
    path,
    authorization,
    apiKey,
    labPolicy: headerValue(headers, "x-lab-policy"),
    model,
    effort,
    thinkingType,
    hasSummaryPrefix: includesMarker(body, SUMMARY_PREFIX),
    hasSystemMarker: includesMarker(body, SYS_MARKER),
    hasThinkingMarker: includesMarker(body, THINK_MARKER),
    hasToolMarker: includesMarker(body, TOOL_MARKER),
    hasCheckpointPrompt: includesMarker(body, "Write the checkpoint"),
    sawFederationToken:
      includesMarker(body, FEDERATION_TOKEN) ||
      authorization?.includes(FEDERATION_TOKEN) === true ||
      apiKey === FEDERATION_TOKEN,
  };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => {
      if (isRecord(event) && typeof event.type === "string") {
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      }
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function openAiText(text: string, finish = "stop", usage?: Record<string, unknown>): string {
  const chunks: unknown[] = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab-model",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    },
  ];
  return `${sse(chunks)}data: [DONE]\n\n`;
}

function openAiDuplicateToolIds(): string {
  const chunk = (delta: unknown) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "lab-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  return `${sse([
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_dup",
          type: "function",
          function: { name: "execute", arguments: "{}" },
        },
      ],
    }),
    chunk({
      tool_calls: [{ index: 1, type: "function", function: { name: "execute", arguments: "" } }],
    }),
    chunk({
      tool_calls: [{ index: 1, id: "call_dup", type: "function", function: { arguments: "{}" } }],
    }),
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ])}data: [DONE]\n\n`;
}

function openAiTools(calls: readonly { id: string; name: string; arguments: string }[]): string {
  return `${sse([
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ])}data: [DONE]\n\n`;
}

function anthropicMessage(params: {
  readonly model: string;
  readonly blocks: readonly Record<string, unknown>[];
  readonly stop: string;
}): string {
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: params.model,
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  ];
  params.blocks.forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "sig_test" },
      });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: params.stop },
    usage: { output_tokens: 0 },
  });
  events.push({ type: "message_stop" });
  return sse(events);
}

async function startLoopback(
  respond: (
    request: InspectedRequest,
    response: ServerResponse,
    index: number,
  ) => Promise<void> | void,
): Promise<Loopback> {
  const requests: InspectedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const raw = await readRequestBody(request);
        let body: unknown;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            body = undefined;
          }
        }
        const inspected = inspectRequest(request.url ?? "/", request.headers, body);
        requests.push(inspected);
        await respond(inspected, response, requests.length - 1);
      } catch {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeCatalog(dir: string, providerId: string, provider: Record<string, unknown>): string {
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify({ providers: { [providerId]: provider } }));
  return path;
}

function objectTool(name: string, description: string): PiTool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  };
}

async function expectAppCode(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(isAppError(error) ? error.code : error).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("Pi 1.0 compatibility", () => {
  const dirs: string[] = [];
  let actualCore: typeof import("@earendil-works/pi-agent-core") | undefined;

  beforeAll(async () => {
    actualCore = await vi.importActual<typeof import("@earendil-works/pi-agent-core")>(
      "@earendil-works/pi-agent-core",
    );
  });

  beforeEach(() => {
    const core = actualCore;
    if (!core) throw new Error("Pi Core import was not ready");
    runAgentLoop.mockImplementation(core.runAgentLoop);
    runAgentLoopContinue.mockImplementation(core.runAgentLoopContinue);
  });

  afterEach(() => {
    runAgentLoop.mockReset();
    runAgentLoopContinue.mockReset();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pr-agent-pi-compat-"));
    dirs.push(dir);
    return dir;
  }

  function labConfig(path: string, providerKeys?: Config["models"]["providerKeys"]): Config {
    return makeTestConfig({
      models: {
        jsonPath: path,
        provider: "lab",
        model: "lab-model",
        api: "openai-completions",
        providerKeys: providerKeys ?? { openai: "unused-openai-key" },
      },
      provider: { promptTimeoutMs: 30_000, retryMax: 0, maxRetryDelayMs: 1 },
      traces: { mode: "off" },
    });
  }

  it("resolves built-in and custom chat models without a type field", async () => {
    const builtin = await createPiRunnerSession({
      cfg: makeTestConfig({ traces: { mode: "off" } }),
      systemPrompt: SYS_MARKER,
      tools: [],
      executors: {},
    });
    await builtin.dispose();
    const builtinModel = getBuiltinModels("openai").find((model) => model.id === "gpt-4o-mini");
    expect(builtinModel?.api).toBe("openai-responses");
    expect(builtinModel && "type" in builtinModel ? builtinModel.type : undefined).not.toBe(
      "image",
    );
    expect(builtinModel?.cost.input).toEqual(expect.any(Number));

    const loop = await startLoopback((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(openAiText("custom-ok"));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [
          { id: "lab-model", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 } },
        ],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
      });
      const result = await session.send("hello", ASK_SEND_OPTS);
      expect(result.text).toBe("custom-ok");
      expect(loop.requests[0]?.model).toBe("lab-model");
      expect(loop.requests[0]?.path).toContain("chat/completions");
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("keeps an explicit API key and catalog headers ahead of env and federation", async () => {
    vi.stubEnv("LAB_API_KEY", "env-key-must-lose");
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "rule-must-not-win");
    vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "org-must-not-win");
    vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", join(tempDir(), "missing-token"));
    const loop = await startLoopback((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(openAiText("authed"));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        authHeader: true,
        headers: { "X-Lab-Policy": "keep" },
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
      });
      await session.send("hello", ASK_SEND_OPTS);
      const request = loop.requests[0];
      expect(request?.authorization).toBe(`Bearer ${EXPLICIT_LAB_KEY}`);
      expect(request?.labPolicy).toBe("keep");
      expect(request?.authorization).not.toContain("env-key-must-lose");
      expect(request?.sawFederationToken).toBe(false);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("does not let Anthropic federation replace an explicit API key", async () => {
    const tokenPath = join(tempDir(), "token");
    writeFileSync(tokenPath, FEDERATION_TOKEN);
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "rule-must-not-win");
    vi.stubEnv("ANTHROPIC_ORGANIZATION_ID", "org-must-not-win");
    vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", "account-must-not-win");
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "workspace-must-not-win");
    vi.stubEnv("ANTHROPIC_IDENTITY_TOKEN_FILE", tokenPath);
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic-must-lose");
    const originalFetch = globalThis.fetch;
    const loop = await startLoopback((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        anthropicMessage({
          model: "claude-haiku-4-5",
          blocks: [{ type: "text", text: "federation-checked" }],
          stop: "end_turn",
        }),
      );
    });
    globalThis.fetch = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.anthropic.com")) {
        return originalFetch(url.replace("https://api.anthropic.com", loop.origin), init);
      }
      return originalFetch(input, init);
    };
    try {
      const session = await createPiRunnerSession({
        cfg: makeTestConfig({
          models: {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            api: "anthropic-messages",
            providerKeys: { anthropic: EXPLICIT_ANTHROPIC_KEY },
          },
          provider: { promptTimeoutMs: 30_000, retryMax: 0, maxRetryDelayMs: 1 },
          traces: { mode: "off" },
        }),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
      });
      const result = await session.send("hello", ASK_SEND_OPTS);
      expect(result.text).toBe("federation-checked");
      expect(loop.requests[0]?.apiKey).toBe(EXPLICIT_ANTHROPIC_KEY);
      expect(loop.requests[0]?.sawFederationToken).toBe(false);
      await session.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      await loop.close();
    }
  }, 20_000);

  it("keeps a tool result between the assistant that called it and the final answer", async () => {
    const calls: string[] = [];
    const loop = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        index === 0
          ? openAiTools([{ id: "call_read", name: "listChangedFiles", arguments: "{}" }])
          : openAiText("final-answer"),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("listChangedFiles", "list")],
        executors: {
          listChangedFiles: async () => {
            calls.push("listChangedFiles");
            return { note: TOOL_MARKER };
          },
        },
      });
      const result = await session.send("look", ASK_SEND_OPTS);
      expect(calls).toEqual(["listChangedFiles"]);
      expect(result.text).toBe("final-answer");
      expect(loop.requests[1]?.hasToolMarker).toBe(true);
      expect(loop.requests).toHaveLength(2);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("runs two nonterminal mutation tools in one batch sequentially, once each", async () => {
    const order: Array<{ name: string; start: number; end: number }> = [];
    const loop = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        index === 0
          ? openAiTools([
              { id: "call_exec_1", name: "execute", arguments: "{}" },
              { id: "call_exec_2", name: "execute", arguments: "{}" },
            ])
          : openAiText("mutations-done"),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("execute", "run")],
        executors: {
          execute: async () => {
            const start = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 40));
            order.push({ name: "execute", start, end: Date.now() });
            return { ok: true };
          },
        },
      });
      const result = await session.send("mutate", ASK_SEND_OPTS);
      expect(result.text).toBe("mutations-done");
      expect(order.map((entry) => entry.name)).toEqual(["execute", "execute"]);
      const first = order[0];
      const second = order[1];
      expect(first && second && second.start >= first.end).toBe(true);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("rejects a duplicate tool-call id before either tool runs", async () => {
    let executions = 0;
    const events: Array<{ kind: string; failureCode?: string }> = [];
    const loop = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(index === 0 ? openAiDuplicateToolIds() : openAiText("duplicate-continued"));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("execute", "run")],
        executors: {
          execute: async () => {
            executions += 1;
            return { ok: true };
          },
        },
        eventSink: (event) => events.push(event),
      });
      await expectAppCode(session.send("duplicate", ASK_SEND_OPTS), "provider.protocol_invalid");
      expect(executions).toBe(0);
      expect(events.some((event) => event.failureCode === "provider.protocol_invalid")).toBe(true);
      expect(JSON.stringify(events)).not.toContain(SYS_MARKER);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("surfaces a rejected terminal submit and still accepts a correction", async () => {
    const codes: string[] = [];
    const original = coreToolsModule.toCoreTools;
    const spy = vi
      .spyOn(coreToolsModule, "toCoreTools")
      .mockImplementation((tools, executors, hostSignal, refresh, observe) =>
        original(tools, executors, hostSignal, refresh, observe).map((tool) => ({
          ...tool,
          execute: async (toolCallId, params, signal, onUpdate) => {
            try {
              return await tool.execute(toolCallId, params, signal, onUpdate);
            } catch (error) {
              if (isAppError(error)) codes.push(error.code);
              throw error;
            }
          },
        })),
      );
    let attempts = 0;
    const loop = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        index === 0
          ? openAiTools([{ id: "call_submit_1", name: "submitVerification", arguments: "{}" }])
          : openAiTools([{ id: "call_submit_2", name: "submitVerification", arguments: "{}" }]),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("submitVerification", "submit")],
        executors: {
          submitVerification: async () => {
            attempts += 1;
            return attempts === 1 ? { accepted: false, error: "range" } : { accepted: true };
          },
        },
      });
      const result = await session.send("submit", ASK_SEND_OPTS);
      expect(codes).toEqual(["tool.submit_rejected"]);
      expect(attempts).toBe(2);
      expect(loop.requests).toHaveLength(2);
      expect(result.end).toBe("completed");
      await session.dispose();
    } finally {
      spy.mockRestore();
      await loop.close();
    }
  }, 20_000);

  it("stops on a provider refusal without another model call", async () => {
    const events: Array<{ kind: string; failureCode?: string }> = [];
    const loop = await startLoopback((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(openAiText("", "refusal"));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
        eventSink: (event) => events.push(event),
      });
      await expectAppCode(session.send("refuse-me", ASK_SEND_OPTS), "provider.refusal");
      expect(loop.requests).toHaveLength(1);
      expect(events.some((event) => event.kind === "retry")).toBe(false);
      expect(events.some((event) => event.failureCode === "provider.refusal")).toBe(true);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("aborts before a later mutation when the host signal fires", async () => {
    const host = new AbortController();
    let mutations = 0;
    let secondCalls = 0;
    let started: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const loop = await startLoopback((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        openAiTools([
          { id: "call_first", name: "execute", arguments: "{}" },
          { id: "call_second", name: "execute", arguments: "{}" },
        ]),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("execute", "run")],
        executors: {
          execute: async (_args, ctx) => {
            if (started) {
              const release = started;
              started = undefined;
              release();
              await new Promise<void>((resolve) => {
                if (ctx?.signal.aborted) {
                  resolve();
                  return;
                }
                ctx?.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              if (!ctx?.signal.aborted) mutations += 1;
              return { ok: true };
            }
            secondCalls += 1;
            mutations += 1;
            return { ok: true };
          },
        },
        hostSignal: host.signal,
      });
      const sendPromise = session.send("abort-me", ASK_SEND_OPTS);
      await startedGate;
      host.abort();
      await expectAppCode(sendPromise, "agent.session_aborted");
      expect(mutations).toBe(0);
      expect(secondCalls).toBe(0);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);

  it("reports idle timeout unless streaming activity refreshes the window", async () => {
    const hang = await startLoopback(() => undefined);
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${hang.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
      });
      await expectAppCode(
        session.send("idle", { ...ASK_SEND_OPTS, deadlineMs: 60 }),
        "pi.prompt_idle_timeout",
      );
      await session.dispose();
    } finally {
      await hang.close();
    }

    const drip = await startLoopback(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = (text: string) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "lab-model",
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`;
      response.write(delta("hel"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      response.write(delta("lo"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "lab-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${drip.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
      });
      const result = await session.send("drip", { ...ASK_SEND_OPTS, deadlineMs: 80 });
      expect(result.text).toBe("hello");
      await session.dispose();
    } finally {
      await drip.close();
    }
  }, 20_000);

  it("retries one transient failure and stops when the budget is exhausted", async () => {
    let transientFailures = 0;
    const transient = await startLoopback((_request, response) => {
      if (transientFailures === 0) {
        transientFailures += 1;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "503 service unavailable", type: "server_error" } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(openAiText("recovered"));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${transient.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const events: Array<{ kind: string }> = [];
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
        eventSink: (event) => events.push(event),
      });
      const result = await session.send("retry", ASK_SEND_OPTS);
      expect(result.text).toBe("recovered");
      expect(transient.requests).toHaveLength(2);
      expect(events.filter((event) => event.kind === "retry")).toHaveLength(1);
      await session.dispose();
    } finally {
      await transient.close();
    }

    const exhausted = await startLoopback((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "503 service unavailable", type: "server_error" } }),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${exhausted.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model" }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
      });
      await expectAppCode(session.send("give-up", ASK_SEND_OPTS), "provider.request_failed");
      expect(exhausted.requests).toHaveLength(2);
      await session.dispose();
    } finally {
      await exhausted.close();
    }
  }, 20_000);

  it("compacts an ask window and keeps overflow recovery paired", async () => {
    const events: Array<{ kind: string; reason?: string }> = [];
    const window = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (index === 1) {
        response.end(openAiTools([{ id: "call_keep", name: "listChangedFiles", arguments: "{}" }]));
        return;
      }
      response.end(
        openAiText(index < 2 ? "acked" : index === 2 ? "summary text" : "after-compact"),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${window.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model", contextWindow: 17_000, maxTokens: 4_096 }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("listChangedFiles", "list")],
        executors: {
          listChangedFiles: async () => ({ note: TOOL_MARKER }),
        },
        eventSink: (event) => events.push(event),
      });
      await session.send("prefix", ASK_SEND_OPTS);
      const result = await session.send("x".repeat(85_000), ASK_SEND_OPTS);
      expect(result.text).toBe("after-compact");
      expect(events.some((event) => event.kind === "compaction" && event.reason === "window")).toBe(
        true,
      );
      const summary = window.requests.find((request) => request.hasCheckpointPrompt);
      const continued = window.requests.find((request) => request.hasSummaryPrefix);
      expect(summary).toBeDefined();
      expect(continued?.hasSystemMarker).toBe(true);
      expect(continued?.hasToolMarker).toBe(true);
      await session.dispose();
    } finally {
      await window.close();
    }

    const review = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        index === 0
          ? openAiTools([{ id: "call_review", name: "listChangedFiles", arguments: "{}" }])
          : openAiText("review-answer"),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${review.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model", contextWindow: 17_000, maxTokens: 4_096 }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        role: "orchestrator",
        systemPrompt: SYS_MARKER,
        tools: [objectTool("listChangedFiles", "list")],
        executors: { listChangedFiles: async () => ({ note: TOOL_MARKER }) },
      });
      const result = await session.send("x".repeat(85_000), {
        phase: "recon",
        checkpointId: "test",
      });
      expect(result.text).toBe("review-answer");
      expect(review.requests.some((request) => request.hasCheckpointPrompt)).toBe(false);
      expect(review.requests).toHaveLength(2);
      await session.dispose();
    } finally {
      await review.close();
    }

    let overflowCalls = 0;
    const overflow = await startLoopback((_request, response) => {
      overflowCalls += 1;
      if (overflowCalls === 3) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Your input exceeds the context window of this model",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (overflowCalls === 2) {
        response.end(
          openAiTools([{ id: "call_overflow", name: "listChangedFiles", arguments: "{}" }]),
        );
        return;
      }
      response.end(openAiText("overflow-recovered"));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${overflow.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model", contextWindow: 128_000 }],
      });
      const overflowEvents: Array<{ kind: string; reason?: string }> = [];
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("listChangedFiles", "list")],
        executors: { listChangedFiles: async () => ({ note: TOOL_MARKER }) },
        eventSink: (event) => overflowEvents.push(event),
      });
      await session.send("prefix", ASK_SEND_OPTS);
      const recovered = await session.send("y".repeat(85_000), ASK_SEND_OPTS);
      expect(recovered.text).toBe("overflow-recovered");
      expect(
        overflowEvents.some((event) => event.kind === "compaction" && event.reason === "overflow"),
      ).toBe(true);
      const continued = overflow.requests.find((request) => request.hasSummaryPrefix);
      expect(continued?.hasSystemMarker).toBe(true);
      expect(continued?.hasToolMarker).toBe(true);
      await session.dispose();
    } finally {
      await overflow.close();
    }
  }, 20_000);

  it("holds orchestrator effort at the ceiling and strips retained adaptive thinking", async () => {
    async function effortFor(
      ceiling: ThinkingPolicy["ceiling"],
      phase: "synthesis" | "recon",
    ): Promise<string | undefined> {
      const loop = await startLoopback((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          anthropicMessage({
            model: "claude-opus-4-7",
            blocks: [{ type: "text", text: "effort-ok" }],
            stop: "end_turn",
          }),
        );
      });
      try {
        const path = writeCatalog(tempDir(), "anthropic", {
          baseUrl: loop.origin,
          api: "anthropic-messages",
          apiKey: EXPLICIT_ANTHROPIC_KEY,
          models: [
            {
              id: "claude-opus-4-7",
              reasoning: true,
              compat: { forceAdaptiveThinking: true, supportsTemperature: false },
              contextWindow: 200_000,
              maxTokens: 8_192,
            },
          ],
        });
        const session = await createPiRunnerSession({
          cfg: makeTestConfig({
            models: {
              jsonPath: path,
              provider: "anthropic",
              model: "claude-opus-4-7",
              api: "anthropic-messages",
              providerKeys: { anthropic: EXPLICIT_ANTHROPIC_KEY },
            },
            provider: { promptTimeoutMs: 30_000, retryMax: 0, maxRetryDelayMs: 1 },
            traces: { mode: "off" },
          }),
          role: "orchestrator",
          thinkingPolicy: { ceiling, levelForPhase: DEFAULT_THINKING_POLICY.levelForPhase },
          systemPrompt: SYS_MARKER,
          tools: [],
          executors: {},
        });
        await session.send("think", { phase, checkpointId: "test" });
        await session.dispose();
        return loop.requests[0]?.effort;
      } finally {
        await loop.close();
      }
    }

    expect(await effortFor("high", "synthesis")).toBe("medium");
    expect(await effortFor("low", "recon")).toBe("low");

    const compacted = await startLoopback((_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (index === 1) {
        response.end(
          anthropicMessage({
            model: "claude-opus-4-7",
            blocks: [
              { type: "thinking", thinking: THINK_MARKER },
              { type: "tool_use", id: "toolu_keep", name: "listChangedFiles", input: {} },
            ],
            stop: "tool_use",
          }),
        );
        return;
      }
      response.end(
        anthropicMessage({
          model: "claude-opus-4-7",
          blocks: [
            {
              type: "text",
              text: index < 1 ? "acked" : index === 2 ? "summary text" : "thinking-stripped",
            },
          ],
          stop: "end_turn",
        }),
      );
    });
    try {
      const path = writeCatalog(tempDir(), "anthropic", {
        baseUrl: compacted.origin,
        api: "anthropic-messages",
        apiKey: EXPLICIT_ANTHROPIC_KEY,
        models: [
          {
            id: "claude-opus-4-7",
            reasoning: true,
            compat: { forceAdaptiveThinking: true, supportsTemperature: false },
            contextWindow: 17_000,
            maxTokens: 4_096,
          },
        ],
      });
      const session = await createPiRunnerSession({
        cfg: makeTestConfig({
          models: {
            jsonPath: path,
            provider: "anthropic",
            model: "claude-opus-4-7",
            api: "anthropic-messages",
          },
          provider: { promptTimeoutMs: 30_000, retryMax: 0, maxRetryDelayMs: 1 },
          traces: { mode: "off" },
        }),
        systemPrompt: SYS_MARKER,
        tools: [objectTool("listChangedFiles", "list")],
        executors: { listChangedFiles: async () => ({ note: TOOL_MARKER }) },
      });
      await session.send("prefix", ASK_SEND_OPTS);
      const result = await session.send("z".repeat(85_000), ASK_SEND_OPTS);
      expect(result.text).toBe("thinking-stripped");
      const continued = compacted.requests.find((request) => request.hasSummaryPrefix);
      expect(continued?.hasThinkingMarker).toBe(false);
      expect(continued?.hasToolMarker).toBe(true);
      expect(continued?.thinkingType).toBe("adaptive");
      await session.dispose();
    } finally {
      await compacted.close();
    }
  }, 20_000);

  it("preserves scripted token and cache counts without treating catalog price as usage", async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
    };
    const events: Array<{
      kind: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
    }> = [];
    const loop = await startLoopback((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(openAiText("counted", "stop", usage));
    });
    try {
      const path = writeCatalog(tempDir(), "lab", {
        baseUrl: `${loop.origin}/v1`,
        api: "openai-completions",
        apiKey: EXPLICIT_LAB_KEY,
        models: [{ id: "lab-model", cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 } }],
      });
      const session = await createPiRunnerSession({
        cfg: labConfig(path),
        systemPrompt: SYS_MARKER,
        tools: [],
        executors: {},
        eventSink: (event) => events.push(event),
      });
      const prompt = "usage-marker-9f3";
      const result = await session.send(prompt, ASK_SEND_OPTS);
      expect(result.usage).toMatchObject({
        estimated: false,
        inputTokens: 50,
        outputTokens: 7,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalTokens: 107,
      });
      expect(events.find((event) => event.kind === "usage")).toMatchObject({
        inputTokens: 50,
        outputTokens: 7,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalTokens: 107,
      });
      expect(JSON.stringify(events)).not.toContain(prompt);
      expect(JSON.stringify(events)).not.toContain(EXPLICIT_LAB_KEY);
      await session.dispose();
    } finally {
      await loop.close();
    }
  }, 20_000);
});
