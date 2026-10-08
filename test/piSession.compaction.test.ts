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

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";
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

const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function reportedUsage(totalTokens: number, input = totalTokens): Usage {
  return {
    totalTokens,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { ...ZERO_RATES, total: 0 },
  };
}

function openAiModel(contextWindow: number): Model<"openai-completions"> {
  return {
    id: "test",
    name: "test",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost: ZERO_RATES,
    reasoning: false,
    contextWindow,
    maxTokens: 100_000,
  };
}

function adaptiveModel(): Model<"anthropic-messages"> {
  return {
    id: "test",
    name: "test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost: ZERO_RATES,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 100_000,
    compat: { forceAdaptiveThinking: true },
  };
}

function userMessage(
  content: string | [{ type: "image"; data: string; mimeType: string }],
): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

function systemMessage(content: string): AgentMessage {
  return { role: "system", content, timestamp: 1 };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: StopReason,
  usage: Usage = reportedUsage(0),
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test",
    usage,
    stopReason,
    timestamp: 1,
  };
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "c",
    toolName: "execute",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

function summaryStream(text: string, stopReason: StopReason = "stop") {
  let captured:
    | {
        context: { messages: Array<{ role: string }> };
        options: { cacheRetention?: string } | undefined;
      }
    | undefined;
  const streamFn: StreamFn = async (_model, context, options) => {
    captured = { context, options };
    const stream = createAssistantMessageEventStream();
    stream.end(assistantMessage([{ type: "text", text }], stopReason, reportedUsage(1)));
    return stream;
  };
  return { streamFn, read: () => captured };
}

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
  const messages: AgentMessage[] = [
    systemMessage("session prompt"),
    ...[0, 1, 2].map((index) => userMessage(`q${index} ${big}`)),
    assistantMessage(
      [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "kept" },
      ],
      "stop",
    ),
  ];
  const model = openAiModel(200_000);

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
    const retained = compacted?.at(-1);
    expect(retained?.role).toBe("assistant");
    if (retained?.role === "assistant") {
      expect(retained.content.some((part) => part.type === "thinking")).toBe(true);
    }
    expect(summary.read()?.options?.cacheRetention).toBe("none");
    expect(summary.read()?.context.messages[0]).toMatchObject({ role: "system" });

    const adaptive = await compactAgentMessages({
      messages,
      model: adaptiveModel(),
      streamFn: summaryStream("SUMMARY").streamFn,
      thinkingCeiling: "max",
    });
    const stripped = adaptive?.at(-1);
    expect(stripped?.role).toBe("assistant");
    if (stripped?.role === "assistant") {
      expect(stripped.content.some((part) => part.type === "thinking")).toBe(false);
      expect(stripped.content).toEqual([{ type: "text", text: "kept" }]);
    }

    const throwing: StreamFn = async () => {
      throw new Error("summary failed");
    };
    for (const streamFn of [
      summaryStream("SUMMARY", "error").streamFn,
      summaryStream("SUMMARY", "aborted").streamFn,
      summaryStream("  ").streamFn,
      throwing,
    ]) {
      await expect(
        compactAgentMessages({ messages, model, streamFn, thinkingCeiling: "max" }),
      ).resolves.toBeUndefined();
    }
  });

  it("uses provider usage, the reserve boundary, and safe cuts", async () => {
    expect(findSafeCutIndex([], 20_000)).toBe(0);
    expect(findSafeCutIndex([userMessage("a".repeat(80_000))], 5)).toBe(0);
    expect(findSafeCutIndex([toolResult("1"), toolResult("2")], 20_000)).toBe(0);
    const paired = [
      assistantMessage([{ type: "toolCall", id: "c", name: "execute", arguments: {} }], "toolUse"),
      toolResult("ok"),
    ];
    expect(findSafeCutIndex(paired, 1)).toBe(0);
    expect(paired[0]?.role).toBe("assistant");

    expect(
      findSafeCutIndex(
        [userMessage("abcd"), userMessage([{ type: "image", data: "", mimeType: "image/png" }])],
        1_200,
      ),
    ).toBe(1);
    expect(
      findSafeCutIndex(
        [
          userMessage("abcd"),
          assistantMessage(
            [
              { type: "thinking", thinking: "12345" },
              { type: "toolCall", id: "c", name: "foo", arguments: { a: 1 } },
            ],
            "toolUse",
          ),
        ],
        4,
      ),
    ).toBe(1);
    expect(findSafeCutIndex([systemMessage("s".repeat(80_000)), userMessage("abcd")], 1)).toBe(0);

    const older = userMessage(`q ${"x".repeat(80_000)}`);
    const recent = userMessage("abcd");
    const usage = reportedUsage(5_000);
    let calls = 0;
    const streamFn: StreamFn = async () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      stream.end(assistantMessage([{ type: "text", text: "SUMMARY" }], "stop", reportedUsage(1)));
      return stream;
    };
    const { usage: _usage, ...missingUsage } = assistantMessage(
      [{ type: "text", text: "" }],
      "stop",
      reportedUsage(1),
    );
    // AssistantMessage requires usage. The runtime still sees provider objects that omit it.
    const omittedUsage = { ...missingUsage, role: "assistant" } as AgentMessage;

    calls = 0;
    await expect(
      compactIfNeeded({
        messages: [older, recent, assistantMessage([{ type: "text", text: "" }], "stop", usage)],
        model: openAiModel(16_384 + 5_000),
        streamFn,
        thinkingCeiling: "off",
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);

    calls = 0;
    const over = await compactIfNeeded({
      messages: [
        older,
        assistantMessage([{ type: "text", text: "" }], "stop", usage),
        userMessage("c".repeat(40)),
      ],
      model: openAiModel(16_384 + 5_000),
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
            assistantMessage([{ type: "text", text: "" }], stopReason, reportedUsage(999_999)),
          ],
          model: openAiModel(16_384 + 100_000),
          streamFn,
          thinkingCeiling: "off",
        }),
      ).resolves.toBeUndefined();
    }
    expect(calls).toBe(0);

    calls = 0;
    await compactIfNeeded({
      messages: [
        older,
        recent,
        assistantMessage([{ type: "text", text: "" }], "stop", reportedUsage(0)),
      ],
      model: openAiModel(16_384 + 20_000),
      streamFn,
      thinkingCeiling: "off",
    });
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      compactIfNeeded({
        messages: [older, recent, omittedUsage],
        model: openAiModel(16_384 + 20_000),
        streamFn,
        thinkingCeiling: "off",
      }),
    ).resolves.toBeTypeOf("object");
    expect(calls).toBe(1);
  });
});
