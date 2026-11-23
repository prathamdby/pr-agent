import { describe, expect, it } from "vitest";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { defineTool, type HarnessSettings } from "@earendil-works/pi-durable";
import { makeTestConfig } from "./helpers/config.ts";
import {
  createDurableTestRuntime,
  createScriptedModels,
  type ScriptedResponse,
} from "./helpers/executorDurableHarness.ts";
import { createDurablePiSession } from "../src/agent/runtime/durable/session.ts";
import { DEFAULT_THINKING_POLICY, DEFAULT_TOOL_POLICY } from "../src/agent/runtime/types.ts";
import { DEFAULT_PROMPT_CACHE_POLICY } from "../src/agent/runtime/promptCachePolicy.ts";
import type { PiSession } from "../src/agent/runtime/types.ts";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { initTraces } from "../src/traces/recorder.ts";

const cfg = makeTestConfig();
const CHECKPOINT = "ckpt-seam";

function textMessage(
  text: string,
  toolCalls: readonly {
    id: string;
    name: string;
    arguments: { readonly [key: string]: never };
  }[] = [],
) {
  return ((pinnedReturn: import("@earendil-works/pi-ai").AssistantMessage) => pinnedReturn)({
    role: "assistant",
    content: [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    ],
    api: "stub-api",
    provider: "stub",
    model: "stub-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  });
}

function hasToolResult(messages: readonly Message[]) {
  return messages.some((message) => message.role === "toolResult");
}

async function createSession(params: {
  readonly tools?: readonly PiTool[];
  readonly executors?: Record<
    string,
    import("../src/agent/providers/interface.ts").AgentRunnerToolExecutor
  >;
  readonly durableTools?: Parameters<typeof createDurablePiSession>[0]["durableTools"];
  readonly compaction?: boolean;
  readonly settings?: HarnessSettings;
  readonly providerSessionId?: string;
  handler?: Parameters<typeof createScriptedModels>[0];
}) {
  const seen: { sessionId?: string }[] = [];
  const models = createScriptedModels(async (model, context, options) => {
    seen.push({ sessionId: options?.sessionId });
    if (params.handler !== undefined) {
      return params.handler(model, context, options);
    }
    return { message: textMessage("done") };
  });
  const runtime = await createDurableTestRuntime({
    models,
    ...(params.settings !== undefined ? { settings: params.settings } : {}),
  });
  const session: PiSession = await createDurablePiSession({
    cfg,
    role: "specialist",
    primary: { provider: "stub", model: "stub-model" },
    thinkingPolicy: DEFAULT_THINKING_POLICY,
    compactionPolicy: { enabled: params.compaction === true },
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    systemPrompt: "system",
    eventSink: () => {},
    tools: params.tools ?? [],
    executors: params.executors ?? {},
    ...(params.durableTools !== undefined ? { durableTools: params.durableTools } : {}),
    codemode: false,
    runtime,
    ...(params.providerSessionId !== undefined
      ? { providerSessionId: params.providerSessionId }
      : {}),
  });
  return { session, seen };
}

const probeTool: PiTool = {
  name: "probe",
  description: "probe tool",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const submitTool: PiTool = {
  name: "submit_report",
  description: "submit",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

describe("durable PiSession seam", () => {
  it("emits session trace spans for a send", async () => {
    const captured: { event: string; spanName?: unknown }[] = [];
    const drain = initTraces(makeTestConfig(), {
      capture(input) {
        captured.push({
          event: input.event,
          spanName: input.properties?.$ai_span_name,
        });
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const { session } = await createSession({});
    const turn = await session.send("hello", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    expect(turn.end).toBe("completed");
    await drain();
    expect(captured.some((entry) => entry.spanName === "generation")).toBe(true);
  });

  it("completes a send with the final assistant text", async () => {
    const { session } = await createSession({});
    let turn;
    try {
      turn = await session.send("hello", {
        phase: "specialist",
        checkpointId: CHECKPOINT,
      });
    } catch (error) {
      console.log("SEND_ERR", JSON.stringify(error, Object.getOwnPropertyNames(error as object)));
      throw error;
    }
    expect(turn.end).toBe("completed");
    expect(turn.text).toBe("done");
    await session.dispose();
  });

  it("runs a tool call then completes on the follow-up request", async () => {
    const calls: string[] = [];
    const { session } = await createSession({
      tools: [probeTool],
      executors: {
        probe: async () => {
          calls.push("probe");
          return { ok: true };
        },
      },
      handler: async (_model, context) => {
        if (!hasToolResult(context.messages)) {
          return {
            message: textMessage("", [{ id: "call-1", name: "probe", arguments: {} }]),
          };
        }
        return { message: textMessage("after-tool") };
      },
    });
    const turn = await session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    expect(calls).toEqual(["probe"]);
    expect(turn.end).toBe("completed");
    await session.dispose();
  });

  it("ends a turn as tool_budget when maxToolRounds is spent", async () => {
    let rounds = 0;
    const { session } = await createSession({
      tools: [probeTool],
      executors: {
        probe: async () => {
          rounds += 1;
          return { ok: true };
        },
      },
      handler: async (_model, context) => {
        if (!hasToolResult(context.messages)) {
          return {
            message: textMessage("", [{ id: `call-${rounds}`, name: "probe", arguments: {} }]),
          };
        }
        return {
          message: textMessage("", [{ id: `call-${rounds}`, name: "probe", arguments: {} }]),
        };
      },
    });
    const turn = await session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
      maxToolRounds: 2,
    });
    expect(rounds).toBe(2);
    expect(turn.end).toBe("tool_budget");
    await session.dispose();
  });

  it("ends a turn as tool_budget once stopAtMs passes", async () => {
    const { session } = await createSession({
      tools: [probeTool],
      executors: { probe: async () => ({ ok: true }) },
      handler: async () => ({
        message: textMessage("", [{ id: "call-loop", name: "probe", arguments: {} }]),
      }),
    });
    const turn = await session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
      stopAtMs: Date.now() - 1,
    });
    expect(turn.end).toBe("tool_budget");
    await session.dispose();
  });

  it("completes when the reserved terminal tool submits after the budget", async () => {
    const { session } = await createSession({
      tools: [probeTool, submitTool],
      executors: {
        probe: async () => ({ ok: true }),
        submit_report: async () => ({ accepted: true }),
      },
      handler: async (_model, context) => {
        const blocked = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            typeof message.content === "object" &&
            JSON.stringify(message.content).includes("budget"),
        );
        return {
          message: textMessage("", [
            {
              id: blocked ? "call-submit" : "call-probe",
              name: blocked ? "submit_report" : "probe",
              arguments: {},
            },
          ]),
        };
      },
    });
    const turn = await session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
      maxToolRounds: 1,
      reservedTerminalTool: "submit_report",
    });
    expect(turn.end).toBe("completed");
    await session.dispose();
  });

  it("aborts an in-flight send", async () => {
    const { session } = await createSession({
      handler: () =>
        new Promise<ScriptedResponse>((resolve) => {
          setTimeout(() => resolve({ message: textMessage("late") }), 5_000);
        }),
    });
    const pending = session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    await session.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    await session.dispose();
  });

  it("records nested host calls under the calling tool's span", async () => {
    const captured: { event: string; properties?: Record<string, unknown> }[] = [];
    const drain = initTraces(makeTestConfig(), {
      capture(input) {
        captured.push({ event: input.event, properties: input.properties });
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const driver = defineTool({
      name: "driver",
      description: "drives a nested call",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_args, api, context) => {
        await api.executeTool("probe", {}, context);
        return { output: [{ type: "text", text: "drove" }] };
      },
    });
    const { session } = await createSession({
      tools: [probeTool],
      durableTools: [driver],
      executors: { probe: async () => ({ ok: true, rows: 2 }) },
      handler: async (_model, context) => {
        if (!hasToolResult(context.messages)) {
          return {
            message: textMessage("", [{ id: "call-1", name: "driver", arguments: {} }]),
          };
        }
        return { message: textMessage("after-tool") };
      },
    });
    const turn = await session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    expect(turn.end).toBe("completed");
    await drain();
    const driverSpan = captured.find((entry) => entry.properties?.$ai_span_name === "tool:driver");
    expect(driverSpan).toBeDefined();
    const hostCalls = driverSpan?.properties?.codemode_host_calls;
    expect(Array.isArray(hostCalls)).toBe(true);
    const probeCall = (hostCalls as Record<string, unknown>[]).find(
      (call) => call.tool === "probe",
    );
    expect(probeCall?.status).toBe("completed");
    await session.dispose();
  });

  it("records executor-emitted metadata and executor host calls", async () => {
    const captured: { event: string; properties?: Record<string, unknown> }[] = [];
    const drain = initTraces(makeTestConfig(), {
      capture(input) {
        captured.push({ event: input.event, properties: input.properties });
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const { session } = await createSession({
      tools: [probeTool],
      executors: {
        probe: async (_args, ctx) => {
          const close = ctx?.traceHostCall?.("lookup", { id: 1 });
          ctx?.emit?.({
            kind: "execution",
            role: "specialist",
            provider: "stub",
            model: "stub-model",
            outcome: "success",
            durationMs: 1,
            admittedHostCalls: 1,
            completedHostCalls: 1,
            transferredBytes: 0,
            outputBytes: 4,
            terminationReason: "completed",
          });
          close?.({ status: "completed", output: "done", outputBytes: 4 });
          return { ok: true };
        },
      },
      handler: async (_model, context) => {
        if (!hasToolResult(context.messages)) {
          return {
            message: textMessage("", [{ id: "call-1", name: "probe", arguments: {} }]),
          };
        }
        return { message: textMessage("after-tool") };
      },
    });
    const turn = await session.send("go", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    expect(turn.end).toBe("completed");
    await drain();
    const probeSpan = captured.find((entry) => entry.properties?.$ai_span_name === "tool:probe");
    expect(probeSpan).toBeDefined();
    expect(probeSpan?.properties?.admitted_host_calls).toBe(1);
    expect(probeSpan?.properties?.completed_host_calls).toBe(1);
    expect(probeSpan?.properties?.termination_reason).toBe("completed");
    const hostCalls = probeSpan?.properties?.codemode_host_calls;
    expect(Array.isArray(hostCalls)).toBe(true);
    const lookup = (hostCalls as Record<string, unknown>[]).find((call) => call.tool === "lookup");
    expect(lookup?.status).toBe("completed");
    await session.dispose();
  });

  it("records a compaction generation when the context compacts", async () => {
    const captured: { event: string; properties?: Record<string, unknown> }[] = [];
    const drain = initTraces(makeTestConfig(), {
      capture(input) {
        captured.push({ event: input.event, properties: input.properties });
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    });
    const { session } = await createSession({
      compaction: true,
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 0,
          reserveTokens: 127_999,
          backgroundTokens: 0,
        },
      },
      handler: async (_model, context) => {
        const [first] = context.messages;
        if (
          first !== undefined &&
          first.role === "system" &&
          contentText(first.content).includes("summarization assistant")
        ) {
          return { message: textMessage("## Goal\nsummarized") };
        }
        return { message: textMessage("done") };
      },
    });
    await session.send("hello", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    const turn = await session.send("again", {
      phase: "specialist",
      checkpointId: CHECKPOINT,
    });
    expect(turn.end).toBe("completed");
    await drain();
    const compaction = captured.find((entry) => entry.properties?.$ai_span_name === "compaction");
    expect(compaction).toBeDefined();
    expect(Array.isArray(compaction?.properties?.$ai_input)).toBe(true);
    await session.dispose();
  });

  it("passes providerSessionId through to the provider request options", async () => {
    const { session, seen } = await createSession({
      providerSessionId: "pr:" + "f".repeat(32),
    });
    await session.send("go", { phase: "specialist", checkpointId: CHECKPOINT });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.sessionId).toBe("pr:" + "f".repeat(32));
    await session.dispose();
  });
});
