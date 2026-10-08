import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const runAgentLoop = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    runAgentLoop,
    runAgentLoopContinue: vi.fn(),
  };
});

import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { compactionPolicyForRole } from "../src/agent/runtime/compactionPolicy.js";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  compactAgentMessages,
  compactIfNeeded,
  findSafeCutIndex,
} from "../src/agent/runtime/transcriptCompaction.js";
import type { AgentSessionRole } from "../src/agent/runtime/types.js";

describe("compactionPolicyForRole", () => {
  it("disables auto-compaction for short review roles", () => {
    for (const role of ["orchestrator", "specialist", "ci_summary"] as const) {
      expect(compactionPolicyForRole(role)).toEqual({ enabled: false });
    }
  });

  it("enables auto-compaction for long interactive roles", () => {
    for (const role of ["ask", "triage", "description", "verification"] as const) {
      expect(compactionPolicyForRole(role)).toEqual({ enabled: true });
    }
  });
});

describe("createFeaturePiSession compaction by role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
      return [];
    });
  });

  async function sendForRole(role: AgentSessionRole) {
    const session = await createFeaturePiSession({
      role,
      cfg: makeTestConfig({ models: { providerKeys: { openai: "k" } } }),
      systemPrompt: role,
      tools: [],
      executors: {},
    });
    await session.send("run", {
      phase: role === "orchestrator" ? "recon" : role === "specialist" ? "specialist" : "ask",
      checkpointId: "cp",
    });
    const config = runAgentLoop.mock.calls.at(-1)?.[2] as {
      maxRetries?: number;
      maxRetryDelayMs?: number;
      prepareNextTurn?: unknown;
    };
    return config;
  }

  it("omits prepareNextTurn for orchestrator and specialist", async () => {
    const orchestrator = await sendForRole("orchestrator");
    const specialist = await sendForRole("specialist");
    expect(orchestrator.prepareNextTurn).toBeUndefined();
    expect(specialist.prepareNextTurn).toBeUndefined();
    expect(orchestrator).toMatchObject({
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
    });
  });

  it("passes prepareNextTurn for ask", async () => {
    const ask = await sendForRole("ask");
    expect(typeof ask.prepareNextTurn).toBe("function");
  });
});

describe("compactAgentMessages overflow", () => {
  const big = "x".repeat(30_000);
  const messages = [
    { role: "system", content: "session prompt", timestamp: 1 },
    ...[0, 1, 2].map((index) => ({
      role: "user",
      content: `q${index} ${big}`,
      timestamp: 1,
    })),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "kept" },
      ],
      timestamp: 1,
    },
  ] as never;
  const model = { api: "openai-completions", maxTokens: 100_000, contextWindow: 200_000 } as never;

  function summaryStream(text: string, stopReason = "stop") {
    let captured:
      | {
          context: { messages: Array<{ role: string }> };
          options: { cacheRetention?: string };
        }
      | undefined;
    const streamFn = (async (
      _model: never,
      context: { messages: Array<{ role: string }> },
      options: { cacheRetention?: string },
    ) => {
      captured = { context, options };
      return {
        result: async () => ({
          stopReason,
          content: [{ type: "text" as const, text }],
        }),
      };
    }) as never;
    return { streamFn, read: () => captured };
  }

  it("keeps the leading system prompt and wraps the summary", async () => {
    const summary = summaryStream("SUMMARY");
    const compacted = await compactAgentMessages({
      messages,
      model,
      streamFn: summary.streamFn,
      thinkingCeiling: "max",
    });
    expect(compacted?.[0]).toMatchObject({ role: "system", content: "session prompt" });
    expect(compacted?.[1]).toMatchObject({
      role: "user",
      content: `${COMPACTION_SUMMARY_PREFIX}SUMMARY${COMPACTION_SUMMARY_SUFFIX}`,
    });
    const retained = compacted?.at(-1) as { content?: Array<{ type: string }> } | undefined;
    expect(retained?.content?.some((part) => part.type === "thinking")).toBe(true);
    expect(summary.read()?.options?.cacheRetention).toBe("none");
    expect(summary.read()?.context?.messages[0]).toMatchObject({ role: "system" });

    const adaptive = await compactAgentMessages({
      messages,
      model: {
        api: "anthropic-messages",
        compat: { forceAdaptiveThinking: true },
        maxTokens: 100_000,
        contextWindow: 200_000,
      } as never,
      streamFn: summaryStream("SUMMARY").streamFn,
      thinkingCeiling: "max",
    });
    const stripped = adaptive?.at(-1) as { content?: Array<{ type: string }> } | undefined;
    expect(stripped?.content?.some((part) => part.type === "thinking")).toBe(false);
    expect(stripped?.content).toEqual([{ type: "text", text: "kept" }]);

    for (const streamFn of [
      summaryStream("SUMMARY", "error").streamFn,
      summaryStream("SUMMARY", "aborted").streamFn,
      summaryStream("  ").streamFn,
      (async () => {
        throw new Error("summary failed");
      }) as never,
    ]) {
      await expect(
        compactAgentMessages({ messages, model, streamFn, thinkingCeiling: "max" }),
      ).resolves.toBeUndefined();
    }
  });

  it("uses provider usage, the reserve boundary, and safe cuts", async () => {
    expect(findSafeCutIndex([], 20_000)).toBe(0);
    expect(
      findSafeCutIndex([{ role: "user", content: "a".repeat(80_000), timestamp: 1 }] as never, 5),
    ).toBe(0);
    expect(
      findSafeCutIndex(
        [
          { role: "toolResult", content: [{ type: "text", text: "1" }], timestamp: 1 },
          { role: "toolResult", content: [{ type: "text", text: "2" }], timestamp: 1 },
        ] as never,
        20_000,
      ),
    ).toBe(0);
    const paired = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "execute", arguments: {} }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "ok" }],
        timestamp: 1,
      },
    ];
    expect(findSafeCutIndex(paired as never, 1)).toBe(0);
    expect(paired[0]?.role).toBe("assistant");

    expect(
      findSafeCutIndex(
        [
          { role: "user", content: "abcd", timestamp: 1 },
          { role: "user", content: [{ type: "image" }], timestamp: 1 },
        ] as never,
        1_200,
      ),
    ).toBe(1);
    expect(
      findSafeCutIndex(
        [
          { role: "user", content: "abcd", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "12345" },
              { type: "toolCall", id: "c", name: "foo", arguments: { a: 1 } },
            ],
            timestamp: 1,
          },
        ] as never,
        4,
      ),
    ).toBe(1);
    expect(
      findSafeCutIndex(
        [
          { role: "system", content: "s".repeat(80_000), timestamp: 1 },
          { role: "user", content: "abcd", timestamp: 1 },
        ] as never,
        1,
      ),
    ).toBe(0);

    const older = { role: "user", content: `q ${"x".repeat(80_000)}`, timestamp: 1 };
    const recent = { role: "user", content: "abcd", timestamp: 1 };
    const usage = {
      totalTokens: 5_000,
      input: 5_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const assistant = (stopReason: string, reported: typeof usage | undefined) => ({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason,
      timestamp: 1,
      ...(reported === undefined ? {} : { usage: reported }),
    });
    let calls = 0;
    const streamFn = (async () => {
      calls += 1;
      return {
        result: async () => ({
          stopReason: "stop",
          content: [{ type: "text", text: "SUMMARY" }],
        }),
      };
    }) as never;
    const windowModel = (contextWindow: number) =>
      ({ api: "openai-completions", maxTokens: 100_000, contextWindow }) as never;

    calls = 0;
    await expect(
      compactIfNeeded({
        messages: [older, recent, assistant("stop", usage)] as never,
        model: windowModel(16_384 + 5_000),
        streamFn,
        thinkingCeiling: "off",
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);

    calls = 0;
    const over = await compactIfNeeded({
      messages: [
        older,
        assistant("stop", usage),
        { role: "user", content: "c".repeat(40), timestamp: 1 },
      ] as never,
      model: windowModel(16_384 + 5_000),
      streamFn,
      thinkingCeiling: "off",
    });
    expect(calls).toBe(1);
    expect(over?.[0]).toMatchObject({
      content: `${COMPACTION_SUMMARY_PREFIX}SUMMARY${COMPACTION_SUMMARY_SUFFIX}`,
    });

    calls = 0;
    for (const stopReason of ["aborted", "error"] as const) {
      await expect(
        compactIfNeeded({
          messages: [
            older,
            recent,
            assistant(stopReason, { ...usage, totalTokens: 999_999, input: 999_999 }),
          ] as never,
          model: windowModel(16_384 + 100_000),
          streamFn,
          thinkingCeiling: "off",
        }),
      ).resolves.toBeUndefined();
    }
    expect(calls).toBe(0);

    calls = 0;
    const zeros = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    await compactIfNeeded({
      messages: [older, recent, assistant("stop", zeros)] as never,
      model: windowModel(16_384 + 20_000),
      streamFn,
      thinkingCeiling: "off",
    });
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      compactIfNeeded({
        messages: [older, recent, assistant("stop", undefined)] as never,
        model: windowModel(16_384 + 20_000),
        streamFn,
        thinkingCeiling: "off",
      }),
    ).resolves.toBeTypeOf("object");
    expect(calls).toBe(1);
  });
});
