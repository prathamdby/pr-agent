import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../src/config.js";

type MockTurnEndEvent = {
  type: "turn_end";
  toolResults: unknown[];
  message: {
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >;
  };
};

function makeAssistantMessage(text: string): MockTurnEndEvent["message"] {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function buildMockSession(script: (emit: (event: MockTurnEndEvent) => void) => void) {
  const listeners = new Set<(event: MockTurnEndEvent) => void>();
  return {
    subscribe(listener: (event: MockTurnEndEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      script((event) => {
        for (const listener of listeners) listener(event);
      });
    },
    abort: vi.fn(),
    setActiveToolsByName: vi.fn(),
  };
}

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "test-model" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({
      setRuntimeApiKey: vi.fn(),
    })),
  },
  createAgentSession: vi.fn(),
  createExtensionRuntime: vi.fn(),
  defineTool: vi.fn((tool: unknown) => tool),
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader() {
    return { reload: vi.fn(async () => undefined) };
  }),
  ModelRegistry: {
    inMemory: vi.fn(() => ({})),
    create: vi.fn(() => ({})),
  },
  SessionManager: { inMemory: vi.fn(() => ({})) },
  SettingsManager: { inMemory: vi.fn(() => ({})) },
}));

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { piAgentRunnerProvider } from "../src/agent/providers/pi/index.js";

const cfg = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  agentProvider: "pi",
  piProvider: "openai",
  piModel: "gpt-4o-mini",
  modelProviderKeys: { openai: "test-key" },
  maxToolRounds: 2,
  maxReviewPublishAttempts: 3,
  maxReviewPublishCalls: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  maxAskToolRounds: 12,
  maxAskFinalizeRounds: 2,
  webhookTimeoutMs: 10_000,
  logLevel: "error",
  enableReviewLabelsEffort: false,
  enableReviewLabelsSecurity: false,
  maxPrFilesListed: 300,
  maxPrFilesPatchBytes: 500_000,
  context7ApiKey: "",
} satisfies Config;

describe("piAgentRunnerProvider.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns terminal answer-turn text and ignores commentary from tool-using turns", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistantMessage("I'll examine the PR.Now let me check files."),
      });
      emit({
        type: "turn_end",
        toolResults: [],
        message: makeAssistantMessage("End-user summary and testing checklist."),
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question");
    expect(result.text).toBe("End-user summary and testing checklist.");
  });

  it("returns empty text when aborted before a terminal answer turn", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistantMessage("I'll examine the PR."),
      });
      emit({
        type: "turn_end",
        toolResults: [{}],
        message: makeAssistantMessage("Let me check more files."),
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question", { maxToolRounds: 2 });
    expect(result.text).toBe("");
    expect(session.abort).toHaveBeenCalled();
  });

  it("returns only text parts from a terminal turn with mixed content", async () => {
    const session = buildMockSession((emit) => {
      emit({
        type: "turn_end",
        toolResults: [],
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "Visible answer." },
            {
              type: "toolCall",
              id: "tc1",
              name: "listPullRequestFiles",
              arguments: {},
            },
          ],
        },
      });
    });
    vi.mocked(createAgentSession).mockResolvedValue({ session } as never);

    const runnerSession = await piAgentRunnerProvider.createSession({
      cfg,
      systemPrompt: "test",
      tools: [],
      executors: {},
    });

    const result = await runnerSession.send("question");
    expect(result.text).toBe("Visible answer.");
  });
});
