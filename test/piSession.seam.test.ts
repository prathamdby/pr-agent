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

  it("reserves one publish_thread call beyond the investigation budget", async () => {
    const beforeDecisions: Array<{ tool: string; blocked: boolean }> = [];
    const finishEnds: boolean[] = [];
    let executedBlockedAfterBudget = false;
    let publishAllowedAfterBudget = false;
    let capturedConfig: {
      beforeToolCall?: (
        ctx: unknown,
        signal?: AbortSignal,
      ) => Promise<{ block?: boolean; reason?: string } | undefined>;
      finishTurn?: (turn: unknown, signal?: AbortSignal) => { action: string } | undefined;
    } | null = null;

    const toolResultFor = (toolName: string, isError: boolean, id: string) => ({
      role: "toolResult" as const,
      toolCallId: id,
      toolName,
      content: [{ type: "text" as const, text: isError ? "blocked" : "ok" }],
      isError,
      timestamp: Date.now(),
    });
    const assistantForTool = (toolName: string, id: string) => ({
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id, name: toolName, arguments: {} }],
    });

    runAgentLoop.mockImplementation(async (_prompts, _context, config, emit) => {
      capturedConfig = config as typeof capturedConfig & object;
      const cfg = config as unknown as {
        beforeToolCall: (ctx: {
          assistantMessage: unknown;
          toolCall: unknown;
          args: unknown;
          context: unknown;
        }) => Promise<{ block?: boolean } | undefined>;
        finishTurn: (turn: {
          message: unknown;
          toolResults: unknown[];
          context: unknown;
          newMessages: unknown[];
        }) => { action: string } | undefined | Promise<{ action: string } | undefined>;
      };
      const simulateToolTurn = async (toolName: string, isError: boolean, step: string) => {
        const id = `${step}-${toolName}`;
        const assistantMessage = assistantForTool(toolName, id);
        const before = await cfg.beforeToolCall({
          assistantMessage,
          toolCall: { id, name: toolName, arguments: {} },
          args: {},
          context: _context,
        });
        beforeDecisions.push({ tool: toolName, blocked: before?.block === true });
        const toolResults = [toolResultFor(toolName, isError, id)];
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: step }],
        };
        const decision = await cfg.finishTurn({
          message,
          toolResults,
          context: _context,
          newMessages: [],
        });
        finishEnds.push(decision?.action === "end");
        await emit({ type: "turn_end", toolResults, message });
        return decision;
      };

      for (let index = 0; index < 4; index += 1) {
        await simulateToolTurn("execute", false, `inv-${index}`);
      }
      const blockedProbe = await cfg.beforeToolCall({
        assistantMessage: assistantForTool("execute", "probe-execute"),
        toolCall: { id: "probe-execute", name: "execute", arguments: {} },
        args: {},
        context: _context,
      });
      executedBlockedAfterBudget = blockedProbe?.block === true;
      const allowedProbe = await cfg.beforeToolCall({
        assistantMessage: assistantForTool("publish_thread", "probe-publish"),
        toolCall: { id: "probe-publish", name: "publish_thread", arguments: {} },
        args: {},
        context: _context,
      });
      publishAllowedAfterBudget = !(allowedProbe?.block === true);
      await simulateToolTurn("publish_thread", false, "terminal");
      await emit({
        type: "turn_end",
        toolResults: [],
        message: { role: "assistant", content: [{ type: "text", text: "judgment-done" }] },
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
      eventSink: () => undefined,
      cfg: makeTestConfig({ modelProviderKeys: { openai: "k" } }),
      tools: [],
      executors: {},
    });

    const turn = await session.send("judge", {
      phase: "judgment",
      checkpointId: "cp-judgment",
      maxToolRounds: 4,
      reservedTerminalTool: "publish_thread",
    });
    expect(turn.text).toBe("judgment-done");
    expect(turn.end).toBe("completed");
    expect(beforeDecisions.slice(0, 4).every((entry) => !entry.blocked)).toBe(true);
    expect(beforeDecisions[4]).toEqual({ tool: "publish_thread", blocked: false });
    expect(executedBlockedAfterBudget).toBe(true);
    expect(publishAllowedAfterBudget).toBe(true);
    expect(finishEnds.slice(0, 4).every((ended) => !ended)).toBe(true);
    expect(finishEnds[4]).toBe(true);

    const cfg = capturedConfig as unknown as {
      beforeToolCall: (ctx: {
        assistantMessage: unknown;
        toolCall: unknown;
        args: unknown;
        context: unknown;
      }) => Promise<{ block?: boolean } | undefined>;
    };
    const againPublish = await cfg.beforeToolCall({
      assistantMessage: assistantForTool("publish_thread", "again-publish"),
      toolCall: { id: "again-publish", name: "publish_thread", arguments: {} },
      args: {},
      context: {},
    });
    expect(againPublish?.block).toBe(true);
    const againExecute = await cfg.beforeToolCall({
      assistantMessage: assistantForTool("execute", "again-execute"),
      toolCall: { id: "again-execute", name: "execute", arguments: {} },
      args: {},
      context: {},
    });
    expect(againExecute?.block).toBe(true);

    await session.dispose();
  });

  it("fits a publish_thread validation-failure retry in the reserved slot", async () => {
    const beforeDecisions: Array<{ tool: string; blocked: boolean }> = [];
    const finishEnds: boolean[] = [];
    let publishAllowedAfterFailure = false;
    let capturedConfig: {
      beforeToolCall?: (
        ctx: unknown,
        signal?: AbortSignal,
      ) => Promise<{ block?: boolean; reason?: string } | undefined>;
    } | null = null;

    const toolResultFor = (toolName: string, isError: boolean, id: string) => ({
      role: "toolResult" as const,
      toolCallId: id,
      toolName,
      content: [{ type: "text" as const, text: isError ? "validation failed" : "ok" }],
      isError,
      timestamp: Date.now(),
    });
    const assistantForTool = (toolName: string, id: string) => ({
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id, name: toolName, arguments: {} }],
    });

    runAgentLoop.mockImplementation(async (_prompts, _context, config, emit) => {
      capturedConfig = config as typeof capturedConfig & object;
      const cfg = config as unknown as {
        beforeToolCall: (ctx: {
          assistantMessage: unknown;
          toolCall: unknown;
          args: unknown;
          context: unknown;
        }) => Promise<{ block?: boolean } | undefined>;
        finishTurn: (turn: {
          message: unknown;
          toolResults: unknown[];
          context: unknown;
          newMessages: unknown[];
        }) => { action: string } | undefined | Promise<{ action: string } | undefined>;
      };
      const simulateToolTurn = async (toolName: string, isError: boolean, step: string) => {
        const id = `${step}-${toolName}`;
        const before = await cfg.beforeToolCall({
          assistantMessage: assistantForTool(toolName, id),
          toolCall: { id, name: toolName, arguments: {} },
          args: {},
          context: _context,
        });
        beforeDecisions.push({ tool: toolName, blocked: before?.block === true });
        const toolResults = [toolResultFor(toolName, isError, id)];
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: step }],
        };
        const decision = await cfg.finishTurn({
          message,
          toolResults,
          context: _context,
          newMessages: [],
        });
        finishEnds.push(decision?.action === "end");
        await emit({ type: "turn_end", toolResults, message });
        return decision;
      };

      for (let index = 0; index < 4; index += 1) {
        await simulateToolTurn("execute", false, `inv-${index}`);
      }
      await simulateToolTurn("publish_thread", true, "terminal-fail");
      const retryProbe = await cfg.beforeToolCall({
        assistantMessage: assistantForTool("publish_thread", "probe-retry"),
        toolCall: { id: "probe-retry", name: "publish_thread", arguments: {} },
        args: {},
        context: _context,
      });
      publishAllowedAfterFailure = !(retryProbe?.block === true);
      await simulateToolTurn("publish_thread", false, "terminal-retry");
      await emit({
        type: "turn_end",
        toolResults: [],
        message: { role: "assistant", content: [{ type: "text", text: "judgment-retry-done" }] },
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
      eventSink: () => undefined,
      cfg: makeTestConfig({ modelProviderKeys: { openai: "k" } }),
      tools: [],
      executors: {},
    });

    const turn = await session.send("judge", {
      phase: "judgment",
      checkpointId: "cp-judgment-retry",
      maxToolRounds: 4,
      reservedTerminalTool: "publish_thread",
    });
    expect(turn.text).toBe("judgment-retry-done");
    expect(turn.end).toBe("completed");
    expect(beforeDecisions.slice(0, 4).every((entry) => !entry.blocked)).toBe(true);
    expect(beforeDecisions[4]).toEqual({ tool: "publish_thread", blocked: false });
    expect(beforeDecisions[5]).toEqual({ tool: "publish_thread", blocked: false });
    expect(publishAllowedAfterFailure).toBe(true);
    expect(finishEnds.slice(0, 5).every((ended) => !ended)).toBe(true);
    expect(finishEnds[5]).toBe(true);

    const cfg = capturedConfig as unknown as {
      beforeToolCall: (ctx: {
        assistantMessage: unknown;
        toolCall: unknown;
        args: unknown;
        context: unknown;
      }) => Promise<{ block?: boolean } | undefined>;
    };
    const againPublish = await cfg.beforeToolCall({
      assistantMessage: assistantForTool("publish_thread", "again-publish"),
      toolCall: { id: "again-publish", name: "publish_thread", arguments: {} },
      args: {},
      context: {},
    });
    expect(againPublish?.block).toBe(true);

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
