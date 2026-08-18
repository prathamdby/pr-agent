import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

const { captureEvent, isAnalyticsEnabled, appendAgentEvents } = vi.hoisted(() => ({
  captureEvent: vi.fn(),
  isAnalyticsEnabled: vi.fn(() => true),
  appendAgentEvents: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent,
  isAnalyticsEnabled,
}));

vi.mock("../src/agentWork/agentEventsRepository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agentWork/agentEventsRepository.js")>();
  return {
    ...actual,
    appendAgentEvents,
    safeAppendAgentEvents: (
      client: unknown,
      cfg: { agentEventsEnabled: boolean },
      rows: unknown[],
    ) => {
      if (!cfg.agentEventsEnabled || rows.length === 0) return;
      void appendAgentEvents(client, rows).catch(() => undefined);
    },
  };
});

import { createDurableLifecycleEventSink } from "../src/agent/runtime/agentEventSink.js";
import {
  AGENT_TOOL_CALLED_EVENT,
  invokeSessionTool,
} from "../src/agent/runtime/sessionToolExecute.js";
import * as reviewRunMetrics from "../src/review/run/reviewRunMetrics.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function toolEvents() {
  return {
    context: {
      pool: {} as never,
      workItemId: "wi-1",
      installationId: 99,
      owner: "acme",
      repo: "app",
      prNumber: 12,
    },
    cfg: makeTestConfig({ agentEventsEnabled: true }),
  };
}

function trace() {
  return {
    role: "orchestrator" as const,
    workType: "review",
    phase: () => "recon" as const,
    validToolNames: ["readWorkspaceFile"],
    events: toolEvents(),
  };
}

describe("invokeSessionTool executor traces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAnalyticsEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records one durable row and one agent tool called event on success", async () => {
    const result = await invokeSessionTool({
      toolName: "readWorkspaceFile",
      args: { path: "src/a.ts" },
      executor: async () => ({ content: "ok" }),
      trace: trace(),
    });
    await flush();

    expect(result).toEqual({ content: "ok" });
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    const rows = appendAgentEvents.mock.calls[0]?.[1] as Array<{
      eventKind: string;
      toolName: string;
      ok: boolean;
      sessionRole: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventKind: "tool",
      toolName: "readWorkspaceFile",
      ok: true,
      sessionRole: "orchestrator",
    });
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith({
      distinctId: "installation:99",
      event: AGENT_TOOL_CALLED_EVENT,
      properties: {
        tool_name: "readWorkspaceFile",
        session_role: "orchestrator",
        work_type: "review",
        phase: "recon",
        ok: true,
        duration: expect.any(Number),
        owner: "acme",
        repo: "app",
        pr_number: 12,
      },
    });
    const properties = captureEvent.mock.calls[0]?.[0]?.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("args");
    expect(properties).not.toHaveProperty("path");
    expect(properties).not.toHaveProperty("content");
  });

  it("records ok false on a failing call", async () => {
    await expect(
      invokeSessionTool({
        toolName: "readWorkspaceFile",
        args: { path: "src/a.ts" },
        executor: async () => {
          throw new Error("boom");
        },
        trace: trace(),
      }),
    ).rejects.toThrow("boom");
    await flush();

    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    const rows = appendAgentEvents.mock.calls[0]?.[1] as Array<{ ok: boolean }>;
    expect(rows[0]?.ok).toBe(false);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent.mock.calls[0]?.[0]?.properties).toMatchObject({
      tool_name: "readWorkspaceFile",
      ok: false,
    });
  });

  it("skips analytics when disabled and still executes", async () => {
    isAnalyticsEnabled.mockReturnValue(false);
    const result = await invokeSessionTool({
      toolName: "readWorkspaceFile",
      args: { path: "src/a.ts" },
      executor: async () => ({ content: "ok" }),
      trace: trace(),
    });
    await flush();

    expect(result).toEqual({ content: "ok" });
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("does not fail execution when analytics throws", async () => {
    captureEvent.mockImplementation(() => {
      throw new Error("posthog down");
    });
    const result = await invokeSessionTool({
      toolName: "readWorkspaceFile",
      args: { path: "src/a.ts" },
      executor: async () => ({ content: "ok" }),
      trace: trace(),
    });
    await flush();
    expect(result).toEqual({ content: "ok" });
  });

  it("throws and traces when no executor is registered", async () => {
    const validToolNames = ["readWorkspaceFile", "getWorkspaceDiff"] as const;
    const metric = vi.spyOn(reviewRunMetrics, "recordReviewMetric");
    await expect(
      invokeSessionTool({
        toolName: "unknown",
        args: {},
        trace: { ...trace(), validToolNames },
      }),
    ).rejects.toMatchObject({
      code: "provider.missing_tool_executor",
      context: { toolName: "unknown", validTools: [...validToolNames] },
    });
    await flush();

    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    expect(appendAgentEvents.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ eventKind: "tool", toolName: "unknown", ok: false }),
    ]);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent.mock.calls[0]?.[0]?.properties).toMatchObject({
      tool_name: "unknown",
      ok: false,
      phase: "recon",
    });
    expect(metric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_call",
        name: "unknown",
        ok: false,
        errorMessage:
          "No executor registered for tool unknown. Valid tools: readWorkspaceFile, getWorkspaceDiff.",
      }),
    );
  });

  it("records a failed trace when refreshBeforeTool throws", async () => {
    const executor = vi.fn(async () => ({ content: "ok" }));
    await expect(
      invokeSessionTool({
        toolName: "readWorkspaceFile",
        args: { path: "src/a.ts" },
        executor,
        refreshBeforeTool: async () => {
          throw new Error("rate limited");
        },
        trace: trace(),
      }),
    ).rejects.toThrow("rate limited");
    await flush();

    expect(executor).not.toHaveBeenCalled();
    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    expect(appendAgentEvents.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ eventKind: "tool", toolName: "readWorkspaceFile", ok: false }),
    ]);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent.mock.calls[0]?.[0]?.properties).toMatchObject({
      tool_name: "readWorkspaceFile",
      ok: false,
    });
  });
});

describe("durable lifecycle sink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips tool-kind lifecycle events and records other kinds once", async () => {
    const sink = createDurableLifecycleEventSink(toolEvents().context, toolEvents().cfg);
    sink({
      kind: "tool",
      role: "orchestrator",
      toolName: "readWorkspaceFile",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    sink({
      kind: "completion",
      role: "orchestrator",
      phase: "recon",
      checkpointId: "cp-1",
      provider: "openai",
      model: "gpt-4o-mini",
      ok: true,
    });
    await flush();

    expect(appendAgentEvents).toHaveBeenCalledTimes(1);
    expect(appendAgentEvents.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ eventKind: "completion", sessionRole: "orchestrator" }),
    ]);
  });
});
