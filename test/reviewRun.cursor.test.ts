import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Config } from "../src/config.js";
import { automatedSecuritySystemPrompt } from "../src/agent/securityPrompt.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 99, updated: true })),
}));

vi.mock("../src/agent/githubTools.js", () => ({
  buildGithubTools: vi.fn(() => ({
    piTools: [
      { name: "getPullRequest", description: "d", parameters: { type: "object", properties: {} } },
      {
        name: "listPullRequestFiles",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
    ],
    executors: {
      getPullRequest: vi.fn(async () => ({})),
      listPullRequestFiles: vi.fn(async () => ({ files: [] })),
    },
  })),
}));

vi.mock("../src/agent/context7Tools.js", () => ({
  buildContext7Tools: vi.fn(() => ({ piTools: [], executors: {} })),
}));

vi.mock("../src/agent/submitReviewTool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/submitReviewTool.js")>();
  return {
    ...actual,
    buildSubmitReviewTool: vi.fn((params) => ({
      piTool: {
        name: "submitReview",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
      executor: vi.fn(async () => {
        params.state.published = true;
        return { ok: true };
      }),
    })),
  };
});

vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(),
  complete: vi.fn(async () => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "cursor review complete" }],
    api: "cursor-sdk",
    provider: "cursor",
    model: "composer-2.5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  })),
}));

import { complete } from "@earendil-works/pi-ai";
import { buildSubmitReviewTool } from "../src/agent/submitReviewTool.js";
import { runFullPrReview } from "../src/agent/reviewRun.js";

const cursorCfg = {
  port: 0,
  githubAppId: "1",
  githubAppPrivateKey: "k",
  webhookSecret: "s",
  piProvider: "cursor",
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

const farFutureTokenExpiry = Date.now() + 3_600_000;

describe("runFullPrReview cursor provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-finite tokenExpiresAtTs", async () => {
    await expect(
      runFullPrReview({
        cfg: cursorCfg,
        token: "t",
        tokenExpiresAtTs: NaN,
        tokenTtlMs: 3_600_000,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
      }),
    ).rejects.toThrow(/tokenExpiresAtTs/);
  });

  it("uses one complete call and security lens prompt for review-security", async () => {
    const result = await runFullPrReview({
      cfg: cursorCfg,
      token: "t",
      tokenExpiresAtTs: farFutureTokenExpiry,
      tokenTtlMs: 3_600_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      mode: "review-security",
    });

    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1);
    const context = vi.mocked(complete).mock.calls[0][1] as { systemPrompt: string };
    expect(context.systemPrompt).toBe(automatedSecuritySystemPrompt);
    expect(result.publishAttempts).toBe(1);
    expect(result.published).toBe(false);
    expect(vi.mocked(buildSubmitReviewTool)).toHaveBeenCalledWith(
      expect.objectContaining({ getToken: expect.any(Function) }),
    );
  });
});
