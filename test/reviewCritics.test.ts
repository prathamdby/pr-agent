import { describe, expect, it, vi } from "vitest";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { makeTestConfig } from "./helpers/config.js";
import {
  CRITIC_INVESTIGATION_TOOL_NAMES,
  runCriticWave,
  selectCriticInvestigationTools,
  withInvestigationCallBudget,
} from "../src/review/run/reviewCritics.js";
import { createInMemoryReviewCheckpointStores } from "../src/review/run/reviewCriticCheckpoint.js";
import { createReviewSessionRegistry } from "../src/review/run/reviewSessionRegistry.js";
import type { ReviewEvidenceSnapshot } from "../src/review/run/reviewEvidence.js";

function mockSession(send: () => Promise<{ text: string }>) {
  return {
    send: vi.fn(send),
    restrictToTools: vi.fn(),
    restoreTools: vi.fn(),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function makeEvidence(overrides: Partial<ReviewEvidenceSnapshot> = {}): ReviewEvidenceSnapshot {
  return {
    contractVersion: 1,
    owner: "owner",
    repo: "repo",
    prNumber: 1,
    baseSha: "basesha",
    headSha: "headsha",
    source: "github-listing",
    truncatedListing: false,
    budgetTier: "small",
    files: [],
    coverageGaps: [],
    sloExempt: false,
    sloExemptReasons: [],
    policyContext: "",
    priorInlineFeedback: null,
    evidenceHash: "evidencehash",
    ...overrides,
  };
}

function validReport() {
  return {
    coverage: "covered",
    findings: [],
    residualRisks: [],
    testingGaps: [],
  };
}

function runnerThatSubmits() {
  const createSession = vi.fn(
    async (params: {
      executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
    }) =>
      mockSession(async () => {
        await params.executors.submitCriticReport?.(validReport());
        return { text: "done" };
      }),
  );
  return { createSession };
}

function runnerThatNeverSubmits() {
  const createSession = vi.fn(async () => mockSession(async () => ({ text: "no submit" })));
  return { createSession };
}

const investigationTools = {
  piTools: [
    { name: "readWorkspaceFile" },
    { name: "searchWorkspace" },
    { name: "getWorkspaceDiff" },
  ] as unknown as readonly PiTool[],
  executors: {
    readWorkspaceFile: vi.fn(async () => ({ content: "file" })),
    searchWorkspace: vi.fn(async () => ({ results: [] })),
    getWorkspaceDiff: vi.fn(async () => ({ diff: "diff" })),
  },
};

describe("selectCriticInvestigationTools", () => {
  it("keeps only the three bounded investigation tools", () => {
    const fullBundle = {
      piTools: [
        { name: "readWorkspaceFile" },
        { name: "searchWorkspace" },
        { name: "getWorkspaceDiff" },
        { name: "listPullRequestFiles" },
        { name: "submitReview" },
      ] as unknown as readonly PiTool[],
      executors: {
        readWorkspaceFile: vi.fn(),
        searchWorkspace: vi.fn(),
        getWorkspaceDiff: vi.fn(),
        listPullRequestFiles: vi.fn(),
        submitReview: vi.fn(),
      },
    };
    const result = selectCriticInvestigationTools(fullBundle);
    expect(result.piTools.map((t) => t.name)).toEqual(CRITIC_INVESTIGATION_TOOL_NAMES);
    expect(Object.keys(result.executors).sort()).toEqual([
      "getWorkspaceDiff",
      "readWorkspaceFile",
      "searchWorkspace",
    ]);
  });
});

describe("withInvestigationCallBudget", () => {
  it("allows calls up to the budget then returns a deterministic budget result", async () => {
    const executors = withInvestigationCallBudget(
      { readWorkspaceFile: async () => ({ content: "ok" }) },
      2,
    );
    const r1 = await executors.readWorkspaceFile({});
    expect(r1).toEqual({ content: "ok" });
    const r2 = await executors.readWorkspaceFile({});
    expect(r2).toEqual({ content: "ok" });
    const r3 = await executors.readWorkspaceFile({});
    expect(r3).toEqual(expect.objectContaining({ budgetExhausted: true }));
  });
});

describe("runCriticWave", () => {
  it("runs all four critics and returns reports in critic order", async () => {
    const runner = runnerThatSubmits();
    const result = await runCriticWave({
      cfg: makeTestConfig(),
      runner,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      evidence: makeEvidence(),
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.reports.map((r) => r.critic)).toEqual([
      "correctness",
      "security",
      "reliability",
      "change-safety",
    ]);
    expect(result.failed).toEqual([]);
    expect(result.requiredFailed).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it("creates exactly four sessions in one wave", async () => {
    const runner = runnerThatSubmits();
    await runCriticWave({
      cfg: makeTestConfig(),
      runner,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      evidence: makeEvidence(),
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(runner.createSession).toHaveBeenCalledTimes(4);
  });

  it("retries a failed critic once in isolation", async () => {
    let correctnessCalls = 0;
    const createSession = vi.fn(
      async (params: {
        executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
      }) => {
        const systemPrompt = (params as unknown as { systemPrompt: string }).systemPrompt;
        if (systemPrompt.includes("Behavioral Correctness")) {
          correctnessCalls += 1;
          if (correctnessCalls === 1) {
            return mockSession(async () => ({ text: "fail" }));
          }
        }
        return mockSession(async () => {
          await params.executors.submitCriticReport?.(validReport());
          return { text: "done" };
        });
      },
    );
    const result = await runCriticWave({
      cfg: makeTestConfig(),
      runner: { createSession },
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      evidence: makeEvidence(),
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(correctnessCalls).toBe(2);
    expect(result.reports.map((r) => r.critic)).toContain("correctness");
    expect(result.failed).toEqual([]);
  });

  it("fails when a required critic exhausts its retry", async () => {
    const runner = runnerThatNeverSubmits();
    const result = await runCriticWave({
      cfg: makeTestConfig(),
      runner,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      evidence: makeEvidence(),
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.failed).toEqual(["correctness", "security", "reliability", "change-safety"]);
    expect(result.requiredFailed).toEqual(["correctness", "security", "reliability"]);
    expect(result.degraded).toBe(false);
  });

  it("marks degraded when only change-safety fails", async () => {
    const createSession = vi.fn(
      async (params: {
        executors: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
      }) => {
        const systemPrompt = (params as unknown as { systemPrompt: string }).systemPrompt;
        if (systemPrompt.includes("Change Safety")) {
          return mockSession(async () => ({ text: "no submit" }));
        }
        return mockSession(async () => {
          await params.executors.submitCriticReport?.(validReport());
          return { text: "done" };
        });
      },
    );
    const result = await runCriticWave({
      cfg: makeTestConfig(),
      runner: { createSession },
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      evidence: makeEvidence(),
      investigationTools,
      registry: createReviewSessionRegistry(),
    });
    expect(result.failed).toEqual(["change-safety"]);
    expect(result.requiredFailed).toEqual([]);
    expect(result.degraded).toBe(true);
  });

  it("reuses completed checkpoints and starts only missing critics", async () => {
    const stores = createInMemoryReviewCheckpointStores();
    const scope = {
      workItemId: "w1",
      headSha: "sha",
      evidenceHash: "evidencehash",
      promptContractVersion: 1,
    };
    await stores.criticStore.claimAttempt({ ...scope, criticId: "correctness" });
    await stores.criticStore.saveCompletedReport(
      { ...scope, criticId: "correctness" },
      validReport(),
    );

    const runner = runnerThatSubmits();
    const result = await runCriticWave({
      cfg: makeTestConfig(),
      runner,
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      evidence: makeEvidence(),
      investigationTools,
      registry: createReviewSessionRegistry(),
      checkpoints: { store: stores.criticStore, workItemId: "w1" },
    });
    expect(result.reusedCriticIds).toEqual(["correctness"]);
    expect(runner.createSession).toHaveBeenCalledTimes(3);
    expect(result.reports.map((r) => r.critic)).toContain("correctness");
  });
});
