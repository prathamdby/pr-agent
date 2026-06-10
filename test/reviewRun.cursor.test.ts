import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import * as evlog from "../src/evlog.js";
import { automatedSecuritySystemPrompt } from "../src/agent/securityPrompt.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 99, updated: true })),
}));

vi.mock("../src/agent/githubTools.js", () => ({
  buildGithubTools: vi.fn(() => ({
    piTools: [
      {
        name: "getPullRequest",
        description: "d",
        parameters: { type: "object", properties: {} },
      },
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

vi.mock("../src/review/publish/submitReviewTool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/publish/submitReviewTool.js")>();
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
import { buildSubmitReviewTool } from "../src/review/publish/submitReviewTool.js";
import { runFullPrReview } from "../src/review/reviewRun.js";

const cursorCfg = makeTestConfig({
  agentProvider: "cursor",
  piModel: "composer-2.5",
  cursorApiKey: "cursor_test_key",
  maxToolRounds: 2,
  reviewConcurrency: 1,
  askConcurrency: 3,
  enableReviewLabelsEffort: false,
});

const farFutureTokenExpiry = Date.now() + 3_600_000;

const cursorCatalog = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
  },
];

describe("runFullPrReview cursor provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCursorModelsForTests(cursorCatalog);
  });

  afterEach(() => {
    resetCursorModelCapabilitiesForTests();
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

  it("uses session sends and security lens prompt for review-security", async () => {
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

    expect(vi.mocked(complete).mock.calls.length).toBeGreaterThan(0);
    const context = vi.mocked(complete).mock.calls[0][1] as {
      systemPrompt: string;
    };
    expect(context.systemPrompt).toBe(automatedSecuritySystemPrompt);
    expect(result.publishAttempts).toBe(3);
    expect(result.published).toBe(false);
    expect(vi.mocked(buildSubmitReviewTool)).toHaveBeenCalledWith(
      expect.objectContaining({ getToken: expect.any(Function) }),
    );
  });

  it("emits review_run_completed with provider cursor", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    const infoSpy = vi.spyOn(evlog, "logInfo");
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      await runFullPrReview({
        cfg: cursorCfg,
        token: "t",
        tokenExpiresAtTs: farFutureTokenExpiry,
        tokenTtlMs: 3_600_000,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
      });
    });
    expect(infoSpy).toHaveBeenCalledWith(
      "review_run_completed",
      expect.objectContaining({
        provider: "cursor",
        model: cursorCfg.piModel,
      }),
    );
    infoSpy.mockRestore();
  });
});
