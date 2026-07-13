import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as evlog from "../src/evlog.js";
import type {
  AgentRunnerCreateSessionParams,
  AgentRunnerProvider,
  AgentRunnerSession,
} from "../src/agent/providers/interface.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";
import {
  initReviewRunMetrics,
  snapshotReviewRunMetrics,
} from "../src/review/run/reviewRunMetrics.js";
import { REVIEWER_IDS } from "../src/review/run/reviewEnsemble.js";
import { REVIEWER_GUIDANCE } from "../src/review/prompts/reviewerPrompt.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  createIssueComment: vi.fn(async () => ({
    id: 99,
    url: "https://example.com/issues/comments/99",
  })),
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 99, updated: true })),
}));

type FakeMode =
  | "happy"
  | "required-correctness-failure"
  | "required-security-failure"
  | "optional-degraded"
  | "cancel-before-publish";

const fakeState = vi.hoisted(() => ({
  mode: "happy" as FakeMode,
  publishCount: 0,
  sessionKinds: [] as string[],
}));

function emptyReport() {
  return {
    coverage: "changed code",
    findings: [] as unknown[],
    residualRisks: [] as string[],
    testingGaps: [] as string[],
  };
}

function highRiskFinding() {
  return {
    severity: "P1" as const,
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    title: "High risk",
    detail: "Trigger path in changed code",
    fixPrompt: "Fix it",
    confidence: 5,
    category: "bug" as const,
    evidence: "diff hunk",
  };
}

function classifySession(params: AgentRunnerCreateSessionParams): string {
  if (params.executors.submitReviewerReport) return "reviewer";
  if (params.executors.submitValidation) return "validator";
  if (params.executors.submitReview) return "orchestrator";
  return "unknown";
}

function reviewerIdFromPrompt(systemPrompt: string): (typeof REVIEWER_IDS)[number] {
  for (const id of REVIEWER_IDS) {
    if (systemPrompt.includes(REVIEWER_GUIDANCE[id])) return id;
  }
  throw new Error("could not identify Reviewer agent angle from system prompt");
}

function createFakeSession(params: AgentRunnerCreateSessionParams): AgentRunnerSession {
  const kind = classifySession(params);
  fakeState.sessionKinds.push(kind);
  const reviewerId = kind === "reviewer" ? reviewerIdFromPrompt(params.systemPrompt) : undefined;

  return {
    send: async () => {
      if (params.signal?.aborted) {
        throw new Error("aborted");
      }
      if (kind === "reviewer" && reviewerId) {
        if (fakeState.mode === "required-correctness-failure" && reviewerId === "correctness") {
          throw new Error("correctness Reviewer agent failed");
        }
        if (fakeState.mode === "required-security-failure" && reviewerId === "security") {
          throw new Error("security Reviewer agent failed");
        }
        if (fakeState.mode === "optional-degraded" && reviewerId === "tests") {
          throw new Error("tests Reviewer agent failed");
        }
        const findings =
          reviewerId === "security" &&
          fakeState.mode !== "required-correctness-failure" &&
          fakeState.mode !== "required-security-failure"
            ? [highRiskFinding()]
            : [];
        await params.executors.submitReviewerReport?.({
          ...emptyReport(),
          findings,
        });
        params.onToolCallMetric?.({
          kind: "tool_call",
          name: "submitReviewerReport",
          ok: true,
          durationMs: 3,
          resultBytes: 2,
          resultCharacters: 2,
        });
        return {
          text: "reviewer done",
          prompt: { inputCharacters: 10, inputBytes: 10 },
          usage: { estimated: true, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      if (kind === "validator") {
        await params.executors.submitValidation?.({
          confirmed: true,
          reason: "trigger path is real",
        });
        params.onToolCallMetric?.({
          kind: "tool_call",
          name: "submitValidation",
          ok: true,
          durationMs: 2,
        });
        return {
          text: "validated",
          prompt: { inputCharacters: 8, inputBytes: 8 },
          usage: { estimated: true, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      if (fakeState.mode === "cancel-before-publish") {
        throw new Error("orchestrator should not run after cancellation");
      }
      await params.executors.submitReview?.({
        prCharacter: "feature",
        findings: [],
        estimatedEffort: "S",
        relevantTests: "none",
        securityConcerns: "none",
        followUps: [],
      });
      fakeState.publishCount += 1;
      params.onToolCallMetric?.({
        kind: "tool_call",
        name: "submitReview",
        ok: true,
      });
      return {
        text: "published",
        prompt: { inputCharacters: 20, inputBytes: 20 },
        usage: { estimated: true, inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      };
    },
    cancel: vi.fn(async () => undefined),
    restrictToTools: vi.fn(),
    restoreTools: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

const fakeProvider: AgentRunnerProvider = {
  createSession: async (params) => createFakeSession(params),
};

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: vi.fn(() => fakeProvider),
}));

vi.mock("../src/review/run/reviewRunSetup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/run/reviewRunSetup.js")>();
  return {
    ...actual,
    buildReviewRunSetup: vi.fn((params) => {
      const submitState = {
        published: false,
        inlinePublished: false,
        inlineReviewId: null as number | null,
        lastValidationError: null as string | null,
        publishCallCount: 0,
        publishCallsExhausted: false,
        publishSuperseded: false,
      };
      return {
        systemPrompt: "Review orchestrator system",
        userContent: "Perform Review synthesis and call submitReview exactly once.",
        reviewerUserContent:
          "Investigate your assigned angle, then call submitReviewerReport exactly once.",
        piTools: [
          { name: "listChangedFiles", description: "list", parameters: {} },
          { name: "submitReview", description: "submit", parameters: {} },
        ],
        executors: {
          listChangedFiles: async () => [],
          submitReview: async () => {
            submitState.published = true;
            submitState.publishCallCount += 1;
            return { ok: true };
          },
        },
        cachedDiffIndex: { files: new Map(), truncated: false },
        submitState,
        getToken: () => params.token,
        getTokenExpiresAtTs: () => params.tokenExpiresAtTs,
        refreshBeforeTool: vi.fn(),
      };
    }),
  };
});

import { runFullPrReview } from "../src/review/run/reviewRun.js";
import { upsertReviewSummaryComment } from "../src/github/reviewPublish.js";

const cfg = makeTestConfig({
  maxToolRounds: 2,
  maxReviewPublishAttempts: 1,
  reviewInjectAnchorMenu: false,
});

function reviewParams(
  overrides: Partial<Parameters<typeof runFullPrReview>[0]> = {},
): Parameters<typeof runFullPrReview>[0] {
  return {
    cfg,
    token: "t",
    tokenExpiresAtTs: Date.now() + 3_600_000,
    tokenTtlMs: 3_600_000,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "sha",
    workspace: mockLocalPrWorkspace(),
    ...overrides,
  };
}

describe("fake-provider full Review run characterization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeState.mode = "happy";
    fakeState.publishCount = 0;
    fakeState.sessionKinds = [];
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
  });

  afterEach(() => {
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("drives Reviewer fan-out through validation and Review synthesis with role-tagged metrics", async () => {
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({ provider: "fake", model: "test", mode: "review" });
      const result = await runFullPrReview(reviewParams());
      expect(result.published).toBe(true);
      expect(fakeState.publishCount).toBe(1);
      expect(fakeState.sessionKinds.filter((k) => k === "reviewer")).toHaveLength(
        REVIEWER_IDS.length,
      );
      expect(fakeState.sessionKinds.filter((k) => k === "orchestrator")).toHaveLength(1);
      expect(fakeState.sessionKinds).toContain("validator");

      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.ensemble).toMatchObject({
        completedReviewerIds: [...REVIEWER_IDS],
        failedReviewerIds: [],
        selectedReviewerIds: [...REVIEWER_IDS],
        omittedReviewerIds: [],
        degraded: false,
        candidateFindings: 1,
        validationTruncatedCandidates: 0,
      });
      expect(snapshot?.bySessionRole["reviewer:correctness"]?.modelTurnCount).toBeGreaterThan(0);
      expect(snapshot?.bySessionRole.validator?.modelTurnCount).toBeGreaterThan(0);
      expect(snapshot?.bySessionRole.orchestrator?.modelTurnCount).toBeGreaterThan(0);
      expect(snapshot?.phaseRoundCounts.investigation).toBeGreaterThan(0);
    });
  });

  it("fails the Review run before publication when required correctness coverage is missing", async () => {
    fakeState.mode = "required-correctness-failure";
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({ provider: "fake", model: "test", mode: "review" });
      await expect(runFullPrReview(reviewParams())).rejects.toThrow(
        "Required review coverage did not complete",
      );
      expect(fakeState.sessionKinds).not.toContain("orchestrator");
      expect(fakeState.publishCount).toBe(0);
      expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.ensemble?.failedReviewerIds).toContain("correctness");
      expect(snapshot?.ensemble?.degraded).toBe(false);
      expect(snapshot?.published).toBe(false);
    });
  });

  it("fails the Review run before publication when required security coverage is missing", async () => {
    fakeState.mode = "required-security-failure";
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({ provider: "fake", model: "test", mode: "review" });
      await expect(runFullPrReview(reviewParams())).rejects.toThrow(
        "Required review coverage did not complete",
      );
      expect(fakeState.publishCount).toBe(0);
      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.ensemble?.failedReviewerIds).toContain("security");
      expect(snapshot?.ensemble?.degraded).toBe(false);
    });
  });

  it("yields a Degraded review when an optional Reviewer agent fails", async () => {
    fakeState.mode = "optional-degraded";
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({ provider: "fake", model: "test", mode: "review" });
      const result = await runFullPrReview(reviewParams());
      expect(result.published).toBe(true);
      const snapshot = snapshotReviewRunMetrics();
      expect(snapshot?.ensemble).toMatchObject({
        failedReviewerIds: ["tests"],
        degraded: true,
      });
      expect(snapshot?.ensemble?.completedReviewerIds).not.toContain("tests");
      expect(snapshot?.ensemble?.completedReviewerIds).toContain("correctness");
      expect(snapshot?.ensemble?.completedReviewerIds).toContain("security");
    });
  });

  it("does not publish a partial Review payload when cancelled after Reviewer fan-out", async () => {
    fakeState.mode = "cancel-before-publish";
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      initReviewRunMetrics({ provider: "fake", model: "test", mode: "review" });
      const result = await runFullPrReview(
        reviewParams({
          shouldAbortPublish: async () =>
            fakeState.sessionKinds.filter((kind) => kind === "reviewer").length >=
            REVIEWER_IDS.length,
        }),
      );
      expect(result.published).toBe(false);
      expect(result.publishSuperseded).toBe(true);
      expect(fakeState.sessionKinds.filter((kind) => kind === "reviewer")).toHaveLength(
        REVIEWER_IDS.length,
      );
      expect(fakeState.sessionKinds).not.toContain("orchestrator");
      expect(fakeState.publishCount).toBe(0);
      expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
    });
  });
});
