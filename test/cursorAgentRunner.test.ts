import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCursorModelCatalog,
  seedCursorModelCatalog,
} from "./helpers/cursorModelCatalogMock.js";
import { Agent } from "@cursor/sdk";
import { makeTestConfig } from "./helpers/config.js";

const completeMock = vi.hoisted(() =>
  vi.fn(async (_model: unknown, context: { messages: unknown[] }) => ({
    role: "assistant",
    content: [{ type: "text", text: `answer ${context.messages.length}` }],
    timestamp: Date.now(),
  })),
);
const bridgeDisposeMock = vi.hoisted(() => vi.fn(async () => undefined));
const createMcpBridgeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    mcpServers: { test: { type: "http", url: "http://127.0.0.1" } },
    dispose: bridgeDisposeMock,
  })),
);

vi.mock("@earendil-works/pi-ai", () => ({
  complete: completeMock,
}));

vi.mock("../src/agent/providers/cursor/mcpBridge.js", () => ({
  createMcpBridge: createMcpBridgeMock,
}));

import { cursorAgentRunnerProvider } from "../src/agent/providers/cursor/agentRunner.js";

const cfg = makeTestConfig({
  agentProvider: "cursor",
  cursorApiKey: "cursor-key",
  piModel: "auto",
});

describe("cursorAgentRunnerProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedCursorModelCatalog([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
      { id: "auto", displayName: "Auto" },
    ]);
  });

  afterEach(() => {
    resetCursorModelCatalog();
  });

  it("passes explicit fast=false for composer-2.5", async () => {
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg: { ...cfg, piModel: "composer-2.5" },
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    await session.dispose();

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "false" }],
        },
      }),
    );
  });

  it("passes fast=true for gpt-5.5-fast", async () => {
    seedCursorModelCatalog([
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
      },
    ]);
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg: { ...cfg, piModel: "gpt-5.5-fast" },
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    await session.dispose();

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "gpt-5.5",
          params: [{ id: "fast", value: "true" }],
        },
      }),
    );
  });

  it("passes fast=true only for composer-2.5-fast", async () => {
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg: { ...cfg, piModel: "composer-2.5-fast" },
      systemPrompt: "system",
      tools: [],
      executors: {},
    });
    await session.dispose();

    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          id: "composer-2.5",
          params: [{ id: "fast", value: "true" }],
        },
      }),
    );
  });

  it("reuses one MCP bridge and Cursor Agent across session sends", async () => {
    const agentDispose = vi.fn(async () => undefined);
    vi.mocked(Agent.create).mockResolvedValue({
      send: vi.fn(),
      [Symbol.asyncDispose]: agentDispose,
    } as never);

    const session = await cursorAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "system",
      tools: [],
      executors: {},
    });

    await expect(session.send("one")).resolves.toEqual({ text: "answer 1" });
    await expect(session.send("two")).resolves.toEqual({ text: "answer 3" });
    await session.dispose();

    expect(createMcpBridgeMock).toHaveBeenCalledTimes(1);
    expect(Agent.create).toHaveBeenCalledTimes(1);
    expect(Agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "auto" },
      }),
    );
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(agentDispose).toHaveBeenCalledTimes(1);
    expect(bridgeDisposeMock).toHaveBeenCalledTimes(1);
  });
});
