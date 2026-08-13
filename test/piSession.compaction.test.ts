import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import { createFeaturePiSession } from "../src/agent/runtime/createFeatureSession.js";
import { compactionPolicyForRole } from "../src/agent/runtime/compactionPolicy.js";
import { resetPiSessionRuntime, setPiSessionRuntime } from "../src/agent/runtime/piSession.js";
import type { PiDefineToolInput, PiSdkSession } from "../src/agent/runtime/piSession.js";
import type { AgentSessionRole } from "../src/agent/runtime/types.js";

const createAgentSession = vi.fn();
type CompactionSettings = { readonly compaction: { readonly enabled: boolean } };
const SettingsManager = { inMemory: vi.fn((_settings: CompactionSettings) => ({})) };

function installTestPiSessionRuntime(): void {
  setPiSessionRuntime({
    ModelRuntime: {
      create: vi.fn(async () => ({
        setRuntimeApiKey: vi.fn(async () => undefined),
        getError: vi.fn(() => undefined),
        getModel: vi.fn(() => ({
          id: "gpt-4o-mini",
          provider: "openai",
          api: "openai-responses",
        })),
        streamSimple: vi.fn(),
        stream: vi.fn(),
        completeSimple: vi.fn(),
        complete: vi.fn(),
      })),
    },
    createAgentSession,
    createExtensionRuntime: vi.fn(() => ({})),
    defineTool: vi.fn((tool: PiDefineToolInput) => tool),
    DefaultResourceLoader: vi.fn(function DefaultResourceLoader() {
      return { reload: vi.fn(async () => undefined) };
    }),
    SessionManager: { inMemory: vi.fn(() => ({})) },
    SettingsManager,
  });
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
    installTestPiSessionRuntime();
    const session: PiSdkSession = {
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: vi.fn(),
      setActiveToolsByName: vi.fn(),
      setThinkingLevel: vi.fn(),
      dispose: vi.fn(),
    };
    createAgentSession.mockResolvedValue({ session });
  });

  afterEach(() => {
    resetPiSessionRuntime();
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
    const settings = SettingsManager.inMemory.mock.calls.map((call) => call[0]);
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
