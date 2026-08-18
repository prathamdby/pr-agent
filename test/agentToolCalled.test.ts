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

import {
  AGENT_TOOL_CALLED_EVENT,
  invokeSessionTool,
} from "../src/agent/runtime/sessionToolExecute.js";

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
});
