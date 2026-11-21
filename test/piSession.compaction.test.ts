import { describe, expect, it } from "vitest";
import { makeTestConfig } from "./helpers/config.ts";
import {
  createDurableTestRuntime,
  createScriptedModels,
} from "./helpers/executorDurableHarness.ts";
import { createDurablePiSession } from "../src/agent/runtime/durable/session.ts";
import { compactionPolicyForRole } from "../src/agent/runtime/compactionPolicy.ts";
import {
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  type AgentSessionRole,
} from "../src/agent/runtime/types.ts";
import { DEFAULT_PROMPT_CACHE_POLICY } from "../src/agent/runtime/promptCachePolicy.ts";

const cfg = makeTestConfig();

describe("compactionPolicyForRole", () => {
  const cases: readonly { role: AgentSessionRole; enabled: boolean }[] = [
    { role: "orchestrator", enabled: false },
    { role: "specialist", enabled: true },
    { role: "ci_summary", enabled: false },
    { role: "ask", enabled: true },
    { role: "triage", enabled: true },
    { role: "description", enabled: true },
    { role: "verification", enabled: true },
  ];
  for (const { role, enabled } of cases) {
    it(`${role} compaction is ${enabled ? "enabled" : "disabled"}`, () => {
      expect(compactionPolicyForRole(role)).toEqual({ enabled });
    });
  }
});

describe("durable session compaction wiring", () => {
  it("creates and completes a send with compaction disabled", async () => {
    const models = createScriptedModels(async () => ({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
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
        stopReason: "stop",
        timestamp: Date.now(),
      },
    }));
    const runtime = await createDurableTestRuntime({ models });
    const session = await createDurablePiSession({
      cfg,
      role: "orchestrator",
      primary: { provider: "stub", model: "stub-model" },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: compactionPolicyForRole("orchestrator"),
      promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
      systemPrompt: "system",
      eventSink: () => {},
      tools: [],
      executors: {},
      codemode: false,
      runtime,
    });
    const turn = await session.send("go", {
      phase: "recon",
      checkpointId: "ckpt-compaction",
    });
    expect(turn.end).toBe("completed");
    await session.dispose();
  });
});
