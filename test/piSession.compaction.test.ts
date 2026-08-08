import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async () => {
      const streamSimple = vi.fn();
      const stream = vi.fn();
      return {
        setRuntimeApiKey: vi.fn(async () => undefined),
        getError: vi.fn(() => undefined),
        getModel: vi.fn(() => ({
          id: "gpt-4o-mini",
          provider: "openai",
          api: "openai-responses",
        })),
        streamSimple,
        stream,
        completeSimple: vi.fn(),
        complete: vi.fn(),
      };
    }),
  },
  createAgentSession: vi.fn(),
  createExtensionRuntime: vi.fn(),
  defineTool: vi.fn((tool: unknown) => tool),
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader() {
    return { reload: vi.fn(async () => undefined) };
  }),
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

import { createAgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { compactionPolicyForRole } from "../src/agent/runtime/compactionPolicy.js";
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
    vi.mocked(createAgentSession).mockResolvedValue({
      session: {
        subscribe: () => () => undefined,
        prompt: async () => undefined,
        abort: vi.fn(),
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        dispose: vi.fn(),
      },
    } as never);
  });

  async function createForRole(role: AgentSessionRole) {
    return createFeaturePiSession({
      role,
      cfg: makeTestConfig({ modelProviderKeys: { openai: "k" } }),
      systemPrompt: role,
      tools: [],
      executors: {},
    });
  }

  it("passes SettingsManager compaction.enabled=false for orchestrator and specialist", async () => {
    await createForRole("orchestrator");
    await createForRole("specialist");
    const settings = vi.mocked(SettingsManager.inMemory).mock.calls.map((call) => call[0]);
    expect(settings).toEqual([
      { compaction: { enabled: false } },
      { compaction: { enabled: false } },
    ]);
  });

  it("passes SettingsManager compaction.enabled=true for ask", async () => {
    await createForRole("ask");
    expect(SettingsManager.inMemory).toHaveBeenCalledWith({
      compaction: { enabled: true },
    });
  });
});
