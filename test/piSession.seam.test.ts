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

import {
  compactionPolicyForRole,
  createPiSession,
  DEFAULT_PROMPT_CACHE_POLICY,
  DEFAULT_THINKING_POLICY,
  DEFAULT_TOOL_POLICY,
  EMPTY_STRUCTURED_STATE,
} from "../src/agent/runtime/piSession.js";

describe("createPiSession seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: { role: "assistant", content: [{ type: "text", text: "seam-ok" }] },
      });
      return [];
    });
  });

  it("creates a session with role, model assignment, and send options", async () => {
    const events: Array<{ kind: string }> = [];
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
    expect(events.map((event) => event.kind)).toContain("turn");
    expect(events.map((event) => event.kind)).toContain("completion");

    await session.dispose();
  });

  it("rejects a resolved loop that ends on an assistant error", async () => {
    const events: Array<{ kind: string }> = [];
    runAgentLoop.mockImplementation(async (_prompts, _context, _config, emit) => {
      await emit({
        type: "turn_end",
        toolResults: [],
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 Too Many Requests: rate limit exceeded",
        },
      });
      return [];
    });

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

    await expect(
      session.send("run", {
        phase: "recon",
        checkpointId: "cp-recon",
        maxToolRounds: 2,
      }),
    ).rejects.toMatchObject({
      code: "provider.request_failed",
    });
    expect(events.map((event) => event.kind)).toContain("failure");
    expect(events.map((event) => event.kind)).not.toContain("completion");

    await session.dispose();
  });

  it("does not import createAgentSession or coding-agent from feature harness paths", async () => {
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
    const forbidden = ["createAgentSession", "pi-coding-agent", "pi-ai/compat", "runAgentLoop"];
    for (const file of featureFiles) {
      const text = await fs.readFile(file, "utf8");
      for (const token of forbidden) {
        if (text.includes(token)) {
          throw new Error(`unexpected ${token} in ${file}`);
        }
      }
    }
  });
});
