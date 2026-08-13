import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "./helpers/config.js";
import {
  compactionPolicyForRole,
  createPiSession,
  DEFAULT_PROMPT_CACHE_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
  resetPiSessionRuntime,
  setPiSessionRuntime,
} from "../src/agent/runtime/piSession.js";
import type {
  PiDefineToolInput,
  PiSdkEvent,
  PiSdkSession,
} from "../src/agent/runtime/piSession.js";

const createAgentSession = vi.fn();

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
    SettingsManager: { inMemory: vi.fn(() => ({})) },
  });
}

describe("createPiSession seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTestPiSessionRuntime();
  });

  afterEach(() => {
    resetPiSessionRuntime();
  });

  it("creates a session with role, model assignment, and send options", async () => {
    const events: Array<{ kind: string }> = [];
    let listener: ((event: PiSdkEvent) => void) | undefined;
    const mockSession: PiSdkSession = {
      subscribe: vi.fn((next: (event: PiSdkEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
      prompt: vi.fn(async () => {
        listener?.({
          type: "turn_end",
          toolResults: [],
          message: { role: "assistant", content: [{ type: "text", text: "seam-ok" }] },
        });
      }),
      abort: vi.fn(),
      setActiveToolsByName: vi.fn(),
      setThinkingLevel: vi.fn(),
      dispose: vi.fn(),
    };
    createAgentSession.mockResolvedValue({ session: mockSession });

    const session = await createPiSession({
      role: "orchestrator",
      primary: { provider: "openai", model: "gpt-4o-mini" },
      thinkingPolicy: DEFAULT_THINKING_POLICY,
      compactionPolicy: compactionPolicyForRole("orchestrator"),
      promptCachePolicy: DEFAULT_PROMPT_CACHE_POLICY,
      toolPolicy: DEFAULT_TOOL_POLICY,
      structuredState: EMPTY_STRUCTURED_STATE,
      systemPrompt: "orchestrator",
      eventSink: (event) => events.push({ kind: event.kind }),
      cfg: makeTestConfig({ modelProviderKeys: { openai: "k" } }),
      tools: [],
      executors: {},
    });

    expect(session.role).toBe("orchestrator");
    expect(session.primary).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    const turn = await session.send("run", {
      phase: "recon",
      checkpointId: "cp-recon",
      maxToolRounds: 2,
    });
    expect(turn.text).toBe("seam-ok");
    expect(mockSession.setThinkingLevel).toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toContain("turn");
    expect(events.map((event) => event.kind)).toContain("completion");

    await session.dispose();
    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it("does not import createAgentSession from feature harness paths (grep gate)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    async function walk(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "runtime" && dir.endsWith("agent")) continue;
          files.push(...(await walk(full)));
        } else if (entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
      return files;
    }
    const featureFiles = [
      ...(await walk("src/review")),
      ...(await walk("src/agent/ask")),
      ...(await walk("src/agent/description")),
      ...(await walk("src/agent/triage")),
      ...(await walk("src/agent/verification")),
      ...(await walk("src/agent/providers")),
    ];
    for (const file of featureFiles) {
      const text = await fs.readFile(file, "utf8");
      if (text.includes("createAgentSession")) {
        throw new Error(`unexpected createAgentSession in ${file}`);
      }
    }
  });
});
