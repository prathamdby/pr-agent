import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../src/config.js";
import * as evlog from "../src/evlog.js";

vi.mock("../src/agent/askSafety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/askSafety.js")>();
  return {
    ...actual,
    buildAskGithubTools: vi.fn(() => ({
      piTools: [
        {
          name: "listPullRequestFiles",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      ],
      executors: {
        listPullRequestFiles: vi.fn(async () => ({ files: [] })),
      },
    })),
  };
});

vi.mock("../src/agent/context7Tools.js", () => ({
  buildContext7Tools: vi.fn(() => ({ piTools: [], executors: {} })),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(),
  complete: vi.fn(async () => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "The function validates input before use." }],
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

import { complete } from "@earendil-works/pi-ai";
import { runAskRun } from "../src/agent/askRun.js";

const cursorCfg = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  agentProvider: "cursor",
  piProvider: "openai",
  piModel: "composer-2.5",
  cursorApiKey: "cursor_test_key",
  maxToolRounds: 2,
  maxReviewPublishAttempts: 3,
  maxReviewPublishCalls: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  maxAskToolRounds: 12,
  maxAskFinalizeRounds: 2,
  webhookTimeoutMs: 10_000,
  logLevel: "error",
  maxReviewFindings: 8,
  enableReviewLabelsEffort: false,
  enableReviewLabelsSecurity: false,
  maxPrFilesListed: 300,
  maxPrFilesPatchBytes: 500_000,
} satisfies Config;

describe("runAskRun cursor provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      replyTarget: { kind: "issue_comment", commentId: 42 },
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
