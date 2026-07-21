import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPublishSummaryTool,
  createSummaryCaptureState,
} from "../src/review/orchestrator/publishSummaryTool.js";
import {
  deterministicOverviewPayload,
  finalizeReviewSummary,
} from "../src/review/orchestrator/summaryFinalizer.js";
import { createThreadPublishRunState } from "../src/review/publish/threadPublishRunState.js";
import { makeTestConfig } from "./helpers/config.js";
import { testTokenHandle } from "./helpers/tokenHandle.js";

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

function makeAbort(
  overrides: {
    superseded?: boolean;
    gate?: "continue" | "deadline" | "superseded";
    publishGate?: "continue" | "stale_head" | "superseded";
  } = {},
) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 60_000,
    markSuperseded: vi.fn(),
    isSuperseded: () => overrides.superseded === true,
    deadlinePassed: () => false,
    shouldKeepRunning: () => overrides.superseded !== true,
    gate: async () => overrides.gate ?? "continue",
    publishGate: async () =>
      overrides.publishGate ?? (overrides.superseded ? "superseded" : "continue"),
    startCheapCancelMonitor: () => ({ stop: async () => undefined }),
    abortSessions: vi.fn(),
  };
}

describe("publish_summary capture + finalizeReviewSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishReviewSummaryOnly.mockResolvedValue({ summaryCommentId: 99 });
  });

  it("captures overview without publishing", async () => {
    const state = createSummaryCaptureState();
    const { executor, hasCaptured, getCapturedOverview } = buildPublishSummaryTool({ state });

    const first = await executor(overviewArgs());
    expect(first).toEqual({
      accepted: true,
      value: {
        duplicate: false,
        overview: expect.objectContaining({ prCharacter: "Adds orchestrator publish tools." }),
      },
    });
    expect(hasCaptured()).toBe(true);
    expect(getCapturedOverview()?.prCharacter).toContain("orchestrator");
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();

    const second = await executor(overviewArgs({ prCharacter: "ignored" }));
    expect(second).toEqual({
      accepted: true,
      value: {
        duplicate: true,
        overview: expect.objectContaining({ prCharacter: "Adds orchestrator publish tools." }),
      },
    });
  });

  it("returns structured validation errors without capturing", async () => {
    const state = createSummaryCaptureState();
    const { executor, getLastError, hasCaptured } = buildPublishSummaryTool({ state });
    await expect(executor({ prCharacter: "" })).resolves.toEqual({
      accepted: false,
      error: expect.stringContaining("prCharacter"),
    });
    expect(getLastError()).toEqual(expect.stringContaining("prCharacter"));
    expect(hasCaptured()).toBe(false);
  });

  it("finalizer is the single publishReviewSummaryOnly call site", async () => {
    const state = createSummaryCaptureState();
    const { executor, getCapturedOverview } = buildPublishSummaryTool({ state });
    await executor(overviewArgs());

    const runState = createThreadPublishRunState({
      acceptedFindings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 1,
          endLine: 1,
          title: "Accepted",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
    });

    const result = await finalizeReviewSummary({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState,
      abort: makeAbort(),
      capturedOverview: getCapturedOverview(),
      forceDeterministic: false,
      judgmentDegraded: false,
      deadlineReached: false,
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(result.published).toBe(true);
    expect(publishReviewSummaryOnly).toHaveBeenCalledTimes(1);
    expect(publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prCharacter: "Adds orchestrator publish tools.",
          findings: runState.acceptedFindings,
        }),
      }),
    );
  });

  it("finalizer uses deterministic overview when forced or capture missing", async () => {
    await finalizeReviewSummary({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
      abort: makeAbort(),
      capturedOverview: null,
      forceDeterministic: true,
      judgmentDegraded: true,
      deadlineReached: false,
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prCharacter: expect.stringContaining("No findings"),
          mergeVerdict: expect.objectContaining({
            rationale: expect.stringContaining("judgment degraded"),
          }),
        }),
        partialCoverageNote: expect.stringContaining("degrad"),
      }),
    );
  });

  it("deadline-only deterministic overview does not say judgment degraded", async () => {
    const finding = {
      severity: "P1" as const,
      file: "src/x.ts",
      startLine: 1,
      endLine: 1,
      title: "Accepted",
      detail: "d",
      fixPrompt: "fix",
    };
    const payload = deterministicOverviewPayload([finding], "deadline");
    expect(payload.prCharacter).toBe("Deterministic summary after run deadline.");
    expect(payload.mergeVerdict?.rationale).toContain("run deadline");
    expect(payload.mergeVerdict?.rationale).not.toContain("judgment degraded");

    await finalizeReviewSummary({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState({ acceptedFindings: [finding] }),
      abort: makeAbort(),
      capturedOverview: null,
      forceDeterministic: true,
      judgmentDegraded: false,
      deadlineReached: true,
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(publishReviewSummaryOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          prCharacter: "Deterministic summary after run deadline.",
          mergeVerdict: expect.objectContaining({
            rationale: expect.stringContaining("run deadline"),
          }),
        }),
        partialCoverageNote: expect.stringMatching(/deadline/i),
      }),
    );
    const publishedPayload = publishReviewSummaryOnly.mock.calls[0]?.[0]?.payload;
    expect(JSON.stringify(publishedPayload)).not.toContain("judgment degraded");
    expect(JSON.stringify(publishedPayload)).not.toContain("judgment degradation");
  });

  it("session-death deterministic wording stays judgment-degraded", () => {
    const payload = deterministicOverviewPayload([], "judgment_degraded");
    expect(payload.prCharacter).toBe("No findings reported on this orchestrated pass.");
    expect(payload.mergeVerdict?.rationale).toContain("judgment degraded");

    const withFindings = deterministicOverviewPayload(
      [
        {
          severity: "P2",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          detail: "d",
          fixPrompt: "f",
        },
      ],
      "judgment_degraded",
    );
    expect(withFindings.prCharacter).toBe("Deterministic summary after judgment degradation.");
    expect(withFindings.mergeVerdict?.rationale).toContain("judgment degraded");
  });

  it("finalizer skips publish when superseded", async () => {
    const result = await finalizeReviewSummary({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      token: testTokenHandle(),
      recordPublishStep: vi.fn(async () => undefined),
      runState: createThreadPublishRunState(),
      abort: makeAbort({ superseded: true, gate: "superseded" }),
      capturedOverview: null,
      forceDeterministic: true,
      judgmentDegraded: false,
      deadlineReached: false,
      owner: "o",
      repo: "r",
      prNumber: 1,
    });
    expect(result.published).toBe(false);
    expect(publishReviewSummaryOnly).not.toHaveBeenCalled();
  });
});
