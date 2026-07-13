import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCursorModelCapabilitiesForTests,
  setCursorModelsForTests,
} from "../src/agent/providers/cursor/modelCapabilities.js";
import * as evlog from "../src/evlog.js";
import { buildOrchestratorSystemPrompt } from "../src/review/prompts/reviewOrchestratorPrompt.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 99, updated: true })),
}));

vi.mock("../src/review/run/reviewEnsemble.js", () => ({
  runReviewerEnsemble: vi.fn(async () => ({
    reports: [
      {
        reviewer: "correctness",
        coverage: "test",
        findings: [],
        residualRisks: [],
        testingGaps: [],
      },
      { reviewer: "security", coverage: "test", findings: [], residualRisks: [], testingGaps: [] },
    ],
    failed: [],
    selected: ["correctness", "security"],
    omitted: [],
  })),
  validateHighRiskFindings: vi.fn(async ({ reports }) => ({
    reports,
    truncatedCandidates: 0,
  })),
  buildSynthesisContext: vi.fn(() => "synthesize"),
}));

vi.mock("../src/agent/tools/context7Tools.js", () => ({
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
import { runFullPrReview } from "../src/review/run/reviewRun.js";

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
const testWorkspace = mockLocalPrWorkspace();

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
        workspace: testWorkspace,
      }),
    ).rejects.toThrow(/tokenExpiresAtTs/);
  });

  it("uses session sends and the unified review prompt", async () => {
    const result = await runFullPrReview({
      cfg: cursorCfg,
      token: "t",
      tokenExpiresAtTs: farFutureTokenExpiry,
      tokenTtlMs: 3_600_000,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      mode: "review",
      workspace: testWorkspace,
    });

    expect(vi.mocked(complete).mock.calls.length).toBeGreaterThan(0);
    const context = vi.mocked(complete).mock.calls[0][1] as {
      systemPrompt: string;
    };
    expect(context.systemPrompt).toBe(buildOrchestratorSystemPrompt());
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
        workspace: testWorkspace,
      });
    });
    expect(infoSpy).toHaveBeenCalledWith(
      "review_run_completed",
      expect.objectContaining({
        provider: "cursor",
        model: cursorCfg.piModel,
        modelTurnCount: expect.any(Number),
        promptBytes: expect.any(Number),
        estimatedInputTokens: expect.any(Number),
        cacheReadTokens: null,
      }),
    );
    infoSpy.mockRestore();
  });
});
