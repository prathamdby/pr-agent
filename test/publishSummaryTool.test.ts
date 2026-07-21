import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPublishSummaryTool,
  createSummaryPublishState,
} from "../src/review/orchestrator/publishSummaryTool.js";
import { createThreadPublishRunState } from "../src/review/orchestrator/publishThreadTool.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";

const publishReviewSummaryOnly = vi.fn();

vi.mock("../src/review/publish/publishSummaryOnly.js", () => ({
  publishReviewSummaryOnly: (...args: unknown[]) => publishReviewSummaryOnly(...args),
}));

function overviewArgs(overrides: Record<string, unknown> = {}) {
  return {
    prCharacter: "Adds orchestrator publish tools.",
    estimatedEffort: 2,
    relevantTests: "partial" as const,
    securityConcerns: null,
    followUps: [],
    mergeVerdict: { score: 4, rationale: "Solid on this pass." },
    ...overrides,
  };
}

describe("publishSummaryTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishReviewSummaryOnly.mockResolvedValue({ summaryCommentId: 99 });
  });

  it("publishes once from runState accepted findings and latches success", async () => {
    const finding = {
      severity: "P1" as const,
      file: "src/x.ts",
      startLine: 1,
      endLine: 1,
      title: "Accepted",
      detail: "d",
      fixPrompt: "fix",
    };
    const runState = createThreadPublishRunState({
      acceptedFindings: [finding],
      inlineReviewIds: [7],
      summaryPlacements: [{ finding, inlineLine: 1, inlinePosted: true }],
    });
    const state = createSummaryPublishState();
    const getToken = vi.fn(() => "tok");

    const { executor } = buildPublishSummaryTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken,
      getTokenExpiresAtTs: () => Date.now() + 3_600_000,
      recordPublishStep: vi.fn(async () => undefined),
      runState,
      state,
    });

    const first = await executor(overviewArgs());
    expect(first).toEqual({ ok: true, summaryCommentId: 99 });
    expect(state.published).toBe(true);
    expect(publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        getToken,
        payload: expect.objectContaining({
          prCharacter: "Adds orchestrator publish tools.",
          findings: [finding],
        }),
        inlineReviewIds: [7],
        summaryPlacements: runState.summaryPlacements,
      }),
    );

    const second = await executor(overviewArgs({ prCharacter: "Should be ignored." }));
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(publishReviewSummaryOnly).toHaveBeenCalledTimes(1);
  });

  it("stores structured validation errors for the repair loop", async () => {
    const state = createSummaryPublishState();
    const { executor } = buildPublishSummaryTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken: () => "tok",
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
      state,
    });

    await expect(executor({ prCharacter: "" })).rejects.toThrow(/validation/i);
    expect(state.lastValidationError).toEqual(expect.stringContaining("prCharacter"));
    expect(state.published).toBe(false);
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
  });

  it("refreshes a near-expiry token before the summary write", async () => {
    let token = "stale";
    let expiresAt = Date.now() + TOKEN_FRESHNESS_BUFFER_MS / 2;
    const refreshInstallationToken = vi.fn(async () => {
      token = "fresh";
      expiresAt = Date.now() + 3_600_000;
      return { token, expiresAtTs: expiresAt };
    });
    publishReviewSummaryOnly.mockImplementationOnce(async (args) => {
      expect(args.getToken()).toBe("fresh");
      return { summaryCommentId: 1 };
    });

    const { executor } = buildPublishSummaryTool({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken: () => token,
      getTokenExpiresAtTs: () => expiresAt,
      refreshInstallationToken,
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
      state: createSummaryPublishState(),
    });

    await executor(overviewArgs());
    expect(refreshInstallationToken).toHaveBeenCalledTimes(1);
  });
});
