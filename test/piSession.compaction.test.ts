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
import { compactAgentMessages } from "../src/agent/runtime/transcriptCompaction.js";
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
      cfg: makeTestConfig({ modelProviderKeys: { openai: "k" } }),
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
  it("keeps the system prompt and normalizes the summary request", async () => {
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
          stopReason: "stop" as const,
          content: [{ type: "text" as const, text: "SUMMARY" }],
        }),
      };
    }) as never;
    const big = "x".repeat(30000);
    const messages = [
      { role: "system", content: "session prompt", timestamp: Date.now() },
      ...[0, 1, 2].map((index) => ({
        role: "user",
        content: `q${index} ${big}`,
        timestamp: Date.now(),
      })),
    ] as never;
    const model = { maxTokens: 100000, contextWindow: 200000 } as never;
    const compacted = await compactAgentMessages({ messages, model, streamFn });
    expect(compacted?.[0]).toMatchObject({ role: "system", content: "session prompt" });
    const summaryMessage = compacted?.[1] as { content?: unknown } | undefined;
    expect(compacted?.[1]).toMatchObject({ role: "user" });
    expect(String(summaryMessage?.content)).toContain("SUMMARY");
    expect(captured?.options?.cacheRetention).toBe("none");
    expect(captured?.context?.messages[0]).toMatchObject({ role: "system" });
  });
});

describe("compactAgentMessages overflow", () => {
  it("keeps the leading system prompt and normalizes the summary request", async () => {
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
          stopReason: "stop" as const,
          content: [{ type: "text" as const, text: "SUMMARY" }],
        }),
      };
    }) as never;
    const big = "x".repeat(30000);
    const messages = [
      { role: "system", content: "session prompt", timestamp: Date.now() },
      ...[0, 1, 2].map((index) => ({
        role: "user",
        content: `q${index} ${big}`,
        timestamp: Date.now(),
      })),
    ] as never;
    const model = { maxTokens: 100000, contextWindow: 200000 } as never;
    const compacted = await compactAgentMessages({ messages, model, streamFn });
    expect(compacted?.[0]).toMatchObject({ role: "system", content: "session prompt" });
    expect(compacted?.[1]).toMatchObject({ role: "user" });
    const summaryContent = (compacted?.[1] as { content?: unknown } | undefined)?.content;
    expect(String(summaryContent)).toContain("SUMMARY");
    expect(captured?.options?.cacheRetention).toBe("none");
    expect(captured?.context?.messages[0]).toMatchObject({ role: "system" });
  });
});
