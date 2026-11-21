import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
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
  const runtime = await createDurableTestRuntime({ models });
  const session: PiSession = await createDurablePiSession({
    cfg,
    role: "specialist",
    primary: { provider: "stub", model: "stub-model" },
    thinkingPolicy: DEFAULT_THINKING_POLICY,
    compactionPolicy: { enabled: false },
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    systemPrompt: "system",
    eventSink: () => {},
    tools: params.tools ?? [],
    executors: params.executors ?? {},
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
