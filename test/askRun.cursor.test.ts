import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import * as evlog from "../src/evlog.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

vi.mock("../src/agent/tools/context7Tools.js", () => ({
  buildContext7Tools: vi.fn(() => ({ piTools: [], executors: {} })),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getModel: vi.fn(),
  complete: vi.fn(async () => ({
    role: "assistant" as const,
    content: [
      {
        type: "text" as const,
        text: "The function validates input before use.",
      },
    ],
    api: "cursor-sdk",
    provider: "cursor",
    model: "composer-2.5",
    usage: {
      input: 8,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  })),
}));

import { complete } from "@earendil-works/pi-ai/compat";
import { runAskRun } from "../src/agent/ask/askRun.js";

const cursorCfg = makeTestConfig({
  agentProvider: "cursor",
  piModel: "composer-2.5",
  cursorApiKey: "cursor_test_key",
  reviewConcurrency: 1,
  askConcurrency: 3,
  enableReviewLabelsEffort: false,
});

const cursorCatalog = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
  },
];

describe("runAskRun cursor provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCursorModelsForTests(cursorCatalog);
  });

  afterEach(() => {
    resetCursorModelCapabilitiesForTests();
  });

  it("returns assistant text from a single complete call", async () => {
    const logSpy = vi.spyOn(evlog, "logInfo");
    const result = await runAskRun({
      cfg: cursorCfg,
      token: "t",
      tokenExpiresAtTs: Date.now() + 3_600_000,
      tokenTtlMs: 3_600_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      question: "What does this function do?",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      workspace: mockLocalPrWorkspace(),
    });

    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1);
    expect(result.replied).toBe(true);
    expect(result.answer).toContain("validates input");
    const askCompleted = logSpy.mock.calls.find(([event]) => event === "ask_run_completed")?.[1];
    expect(askCompleted).toMatchObject({ provider: "cursor", hasAnswer: true });
    expect(askCompleted).not.toHaveProperty("toolRounds");
    expect(askCompleted).not.toHaveProperty("rateLimitCircuitOpened");
  });
});
