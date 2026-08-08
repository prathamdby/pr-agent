import { describe, expect, it } from "vitest";
import {
  compactionPolicyForRole,
  createFakePiSession,
  DEFAULT_PROMPT_CACHE_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
} from "../src/agent/runtime/piSession.js";
import { makeTestConfig } from "./helpers/config.js";

function baseParams() {
  return {
    role: "specialist" as const,
    primary: { provider: "openai", model: "gpt-4o-mini" },
    fallback: { provider: "openai", model: "gpt-4o" },
    thinkingPolicy: DEFAULT_THINKING_POLICY,
    compactionPolicy: compactionPolicyForRole("specialist"),
    promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
    toolPolicy: DEFAULT_TOOL_POLICY,
    structuredState: {
      version: 1,
      payload: { reports: ["security"], checkpoint: "cp-1" },
    },
    systemPrompt: "test",
    eventSink: () => undefined,
    cfg: makeTestConfig(),
    tools: [],
    executors: {},
  };
}

describe("createFakePiSession", () => {
  it("records sends with phase and checkpoint, and supports abort/dispose", async () => {
    const { session, controls } = createFakePiSession(baseParams(), async () => "ok");
    const turn = await session.send("hello", {
      phase: "specialist",
      checkpointId: "cp-1",
      maxToolRounds: 3,
    });
    expect(turn.text).toBe("ok");
    expect(controls.sends).toHaveLength(1);
    expect(controls.sends[0]?.opts.checkpointId).toBe("cp-1");
    expect(controls.events.some((event) => event.kind === "turn")).toBe(true);
    expect(controls.events.some((event) => event.kind === "completion")).toBe(true);

    await session.abort();
    expect(controls.events.some((event) => event.kind === "cancellation")).toBe(true);
    await session.dispose();
    await expect(
      session.send("again", { phase: "specialist", checkpointId: "cp-1" }),
    ).rejects.toThrow(/disposed|aborted/);
  });

  it("restarts with fallback from structured state without mid-session model switch", async () => {
    const { session } = createFakePiSession(baseParams(), async () => "primary");
    expect(session.primary.model).toBe("gpt-4o-mini");
    const restarted = await session.restartWithFallback({
      checkpointId: "cp-2",
      structuredState: {
        version: 2,
        payload: { reports: ["security"], checkpoint: "cp-2" },
      },
    });
    expect(restarted.primary.model).toBe("gpt-4o");
    expect(restarted.getStructuredState().payload.checkpoint).toBe("cp-2");
  });

  it("preserves empty structured state helper", () => {
    expect(EMPTY_STRUCTURED_STATE.payload).toEqual({});
  });
});
