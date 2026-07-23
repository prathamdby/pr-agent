import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunnerProvider, AgentRunnerSession } from "../src/agent/providers/interface.js";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { AppError } from "../src/errors/appError.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/index.js";
import type {
  FindingLedger,
  ReviewCoverage,
  SpecialistId,
  SpecialistOutcome,
} from "../src/review/orchestrator/orchestratorTypes.js";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import type { Pool } from "pg";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS } from "../src/settings/index.js";
import * as evlog from "../src/evlog.js";
import { snapshotReviewRunMetrics } from "../src/review/run/reviewRunMetrics.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const testState = vi.hoisted(() => ({
  outcomes: new Map<string, Deferred<SpecialistOutcome>>(),
  publishOrder: [] as string[],
  activeSource: null as SpecialistId | null,
  ledger: null as FindingLedger | null,
  summaryNotes: [] as Array<string | undefined>,
  failureNotices: 0,
  refreshes: 0,
  briefMessages: [] as string[],
  signals: new Map<string, AbortSignal>(),
  transitions: [] as string[][],
  sessionAborts: 0,
  sessionDisposals: 0,
  judgmentFailuresRemaining: 0,
  reconSubmitsBrief: true,
  deterministicSummaries: [] as Array<Record<string, unknown>>,
  ticks: [] as Array<{ readonly progressRevision: number; readonly kind: string }>,
  createError: null as Error | null,
  createDelayMs: 0,
  sendDelay: null as {
    readonly phase: "recon" | "judgment" | "synthesis";
    readonly ms: number;
  } | null,
  restrictionFailureTool: null as string | null,
  publishedBatchCount: 0,
  synthesisPublishesSummary: true,
}));

vi.mock("../src/review/run/reviewRunSetup.js", () => ({
  buildReviewRunSetup: vi.fn(() => ({
    systemPrompt: "legacy prompt must not be used",
    userContent: "Inspect the pull request.",
    workspaceTools: { piTools: [], executors: {} },
    cachedDiffIndex: {
      files: new Map(),
      truncated: false,
      listPullRequestFilesIngested: false,
    },
    getToken: () => "token",
    getTokenExpiresAtTs: () => Date.now() + 60_000,
    refreshBeforeTool: vi.fn(async () => undefined),
    refreshLiveAuth: vi.fn(async () => {
      testState.refreshes += 1;
    }),
  })),
}));

vi.mock("../src/review/orchestrator/specialistRun.js", () => ({
  runSpecialist: vi.fn(
    (params: {
      readonly specialist: SpecialistId;
      readonly briefMessage: string;
      readonly signal?: AbortSignal;
    }) => {
      const outcome = testState.outcomes.get(params.specialist);
      if (!outcome) throw new Error(`Missing ${params.specialist} outcome`);
      testState.briefMessages.push(params.briefMessage);
      if (params.signal) testState.signals.set(params.specialist, params.signal);
      return new Promise<SpecialistOutcome>((resolve) => {
        outcome.promise.then(resolve);
        params.signal?.addEventListener("abort", () => resolve(failed(params.specialist)), {
          once: true,
        });
      });
    },
  ),
}));

vi.mock("../src/review/orchestrator/publishThreadTool.js", () => ({
  buildPublishThreadTool: vi.fn(() => {
    testState.ledger = createFindingLedger();
    return {
      piTool: { name: "publish_thread", description: "publish", parameters: {} },
      executor: vi.fn(async (args: { findings?: readonly ReviewFinding[] }) => {
        if (!testState.activeSource) throw new Error("missing active source");
        testState.publishOrder.push(testState.activeSource);
        testState.publishedBatchCount += 1;
        const ledger = testState.ledger ?? createFindingLedger();
        const accepted = (args.findings ?? []).map((item, index) => ({
          kind: "posted" as const,
          source: testState.activeSource ?? "correctness",
          placement: { finding: item, inlineLine: item.startLine, inlinePosted: true },
          canonicalFingerprint: `${testState.activeSource}-${index}-${item.file}`,
          reviewId: testState.publishOrder.length,
        }));
        testState.ledger = {
          ...ledger,
          accepted: [...ledger.accepted, ...accepted],
          postedInlineCount: ledger.postedInlineCount + accepted.length,
          threadCallCount: ledger.threadCallCount + 1,
        };
        return {
          kind: "empty",
          delta: {
            accepted: [],
            suppressionFingerprints: [],
            inlineReviewIds: [],
            postedInlineCount: 0,
            threadCallCount: 1,
            threadBudgetExhausted: false,
          },
          publishedThreadOverlapHints: [],
        };
      }),
      setSource: (source: SpecialistId) => {
        testState.activeSource = source;
      },
      getLedger: () => testState.ledger ?? createFindingLedger(),
      getPublishedBatchCount: () => testState.publishedBatchCount,
      getStopReason: () => null,
    };
  }),
}));

vi.mock("../src/review/orchestrator/publishSummaryTool.js", () => ({
  createPublishSummaryState: vi.fn(() => ({ published: false, lastValidationError: null })),
  buildPublishSummaryTool: vi.fn(
    (params: { state: { published: boolean }; getCoverage: () => ReviewCoverage }) => ({
      piTool: { name: "publish_summary", description: "summary", parameters: {} },
      executor: vi.fn(async () => {
        testState.publishOrder.push("summary");
        const coverage = params.getCoverage();
        testState.summaryNotes.push(coverage.kind === "partial" ? coverage.note : undefined);
        params.state.published = true;
        return { ok: true, summaryCommentId: 9 };
      }),
    }),
  ),
}));

vi.mock("../src/review/orchestrator/stubTick.js", () => ({
  tickProgressComment: vi.fn(
    async (params: {
      progressRevision: number;
      tickState: { kind: string };
      refreshLiveAuth?: () => Promise<void>;
    }) => {
      await params.refreshLiveAuth?.();
      testState.ticks.push({
        progressRevision: params.progressRevision,
        kind: params.tickState.kind,
      });
    },
  ),
}));

vi.mock("../src/review/run/reviewRunFallback.js", () => ({
  publishReviewRunFailureNotice: vi.fn(async () => {
    testState.failureNotices += 1;
  }),
}));

vi.mock("../src/review/publish/publishSummaryOnly.js", () => ({
  publishReviewSummaryOnly: vi.fn(async (params: { readonly payload: Record<string, unknown> }) => {
    testState.publishOrder.push("summary");
    testState.deterministicSummaries.push(params.payload);
    return { kind: "published", summaryCommentId: 10 };
  }),
}));

const runner = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("../src/agent/providers/index.js", () => ({
  resolveAgentRunnerProvider: () =>
    ({ createSession: runner.createSession }) satisfies AgentRunnerProvider,
}));

import {
  runOrchestratedPrReview,
  type OrchestratedReviewRunParams,
} from "../src/review/orchestrator/orchestratorRun.js";

const workspace: LocalPrWorkspace = {
  rootDir: "/tmp/orchestrator-test",
  privateGitDir: "/tmp/orchestrator-test/.git",
  agentCwd: "/tmp/orchestrator-test/agent",
  changedFiles: [],
  changedFileByPath: new Map(),
  checkoutPaths: new Set(),
  sortedCheckoutPaths: [],
  checkoutMode: "full",
  diffIndex: { files: new Map(), truncated: false, listPullRequestFilesIngested: false },
  stats: { truncated: false, totalChanges: 0, fileCount: 0 },
  grepLiteral: async () => ({ matches: [], truncated: false }),
  getDiffForPath: async () => "",
  getBlameForPath: async () => "",
  isPathInCheckout: () => false,
  cleanup: async () => undefined,
};

function finding(specialist: SpecialistId): ReviewFinding {
  return {
    severity: "P2",
    file: `src/${specialist}.ts`,
    startLine: 1,
    endLine: 1,
    title: `${specialist} finding`,
    detail: `The ${specialist} path is incorrect.`,
  };
}

function report(specialist: SpecialistId): SpecialistOutcome {
  return {
    kind: "report",
    specialist,
    durationMs: 1,
    report: { status: "findings", findings: [finding(specialist)] },
  };
}

function empty(specialist: SpecialistId): SpecialistOutcome {
  return { kind: "empty", specialist, durationMs: 1 };
}

function failed(specialist: SpecialistId, message = `${specialist} failed`): SpecialistOutcome {
  return {
    kind: "error",
    specialist,
    durationMs: 1,
    error: new AppError({
      code: "review.specialist_failed",
      message,
      cause: new Error(message),
    }),
  };
}

function params(): OrchestratedReviewRunParams {
  const now = Date.now();
  return {
    cfg: makeTestConfig(),
    token: "token",
    tokenExpiresAtTs: now + 60_000,
    tokenTtlMs: 60_000,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "a".repeat(40),
    workspace,
    cwd: workspace.agentCwd,
    prTitle: "Add orchestrated reviews",
    prBody: "Dispatch four specialists.",
    timing: {
      returnByMs: now + 60_000,
      modelStopAtMs: now + 50_000,
      remainingModelMs: () => 50_000,
      remainingTotalMs: () => 60_000,
    },
    gate: { check: async () => ({ kind: "continue" }) },
  };
}

function paramsWithGate(
  check: OrchestratedReviewRunParams["gate"]["check"],
): OrchestratedReviewRunParams {
  return { ...params(), gate: { check } };
}

function coordinatedRecordPublishStep() {
  return Object.assign(
    vi.fn(async () => undefined),
    {
      summaryCommentCoordination: {
        pool: Object.create(null) as Pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
      },
    },
  );
}

function hardDeadlineParams(): OrchestratedReviewRunParams {
  const startedAt = Date.now();
  const modelStopAtMs = startedAt + 50;
  const returnByMs = startedAt + 100;
  return {
    ...params(),
    timing: {
      modelStopAtMs,
      returnByMs,
      remainingModelMs: () => Math.max(0, modelStopAtMs - Date.now()),
      remainingTotalMs: () => Math.max(0, returnByMs - Date.now()),
    },
  };
}

describe("runOrchestratedPrReview", () => {
  beforeEach(() => {
    testState.outcomes.clear();
    testState.publishOrder.length = 0;
    testState.activeSource = null;
    testState.summaryNotes.length = 0;
    testState.failureNotices = 0;
    testState.refreshes = 0;
    testState.briefMessages.length = 0;
    testState.signals.clear();
    testState.transitions.length = 0;
    testState.sessionAborts = 0;
    testState.sessionDisposals = 0;
    testState.judgmentFailuresRemaining = 0;
    testState.reconSubmitsBrief = true;
    testState.deterministicSummaries.length = 0;
    testState.ticks.length = 0;
    testState.createError = null;
    testState.createDelayMs = 0;
    testState.sendDelay = null;
    testState.restrictionFailureTool = null;
    testState.publishedBatchCount = 0;
    testState.synthesisPublishesSummary = true;
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.set(specialist, deferred());
    }

    runner.createSession.mockImplementation(async (sessionParams) => {
      if (testState.createError) throw testState.createError;
      if (testState.createDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, testState.createDelayMs));
      }
      const executors = sessionParams.executors;
      const session: AgentRunnerSession = {
        send: vi.fn(async (prompt) => {
          const phase = prompt.includes("Inspect this pull request")
            ? "recon"
            : prompt.startsWith("Judge the ")
              ? "judgment"
              : prompt.includes("Synthesize the final")
                ? "synthesis"
                : null;
          if (testState.sendDelay?.phase === phase) {
            const delay = testState.sendDelay;
            testState.sendDelay = null;
            await new Promise<void>((resolve) => setTimeout(resolve, delay.ms));
            return { text: "late" };
          }
          if (prompt.includes("Inspect this pull request")) {
            if (testState.reconSubmitsBrief)
              await executors.submit_specialist_brief?.({
                prIntent: "Add orchestrated reviews.",
                architectureNotes: "One orchestrator owns publication.",
                riskAreas: [],
                fileMap: "Four specialist files.",
                specialistFocus: {
                  correctness: "Trace behavior.",
                  security: "Trace trust boundaries.",
                  quality: "Trace maintainability.",
                  tests: "Trace coverage.",
                },
              });
          } else if (prompt.startsWith("Judge the ")) {
            if (testState.judgmentFailuresRemaining > 0) {
              testState.judgmentFailuresRemaining -= 1;
              throw new Error("judgment provider failure");
            }
            await sessionParams.refreshBeforeTool?.("publish_thread");
            await executors.publish_thread?.({ findings: [] });
          } else if (
            prompt.includes("Synthesize the final") ||
            prompt.includes("Call publish_summary now") ||
            prompt.includes("Fix the summary and call publish_summary")
          ) {
            if (testState.synthesisPublishesSummary) {
              await sessionParams.refreshBeforeTool?.("publish_summary");
              await executors.publish_summary?.({});
            }
          }
          return { text: "ok" };
        }),
        abort: vi.fn(async () => {
          testState.sessionAborts += 1;
        }),
        restrictToTools: vi.fn((tools: readonly PiTool[]) => {
          if (
            testState.restrictionFailureTool != null &&
            tools.some((tool) => tool.name === testState.restrictionFailureTool)
          ) {
            testState.restrictionFailureTool = null;
            throw new Error("restriction failed");
          }
          testState.transitions.push(tools.map((tool) => tool.name));
        }),
        restoreTools: vi.fn(),
        dispose: vi.fn(async () => {
          testState.sessionDisposals += 1;
        }),
      };
      return session;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("caps orchestrator judgment turns at four tool rounds", () => {
    expect(ORCHESTRATOR_JUDGMENT_MAX_TOOL_ROUNDS).toBe(4);
  });

  it("uses fallback recon and deterministic publication when session creation fails", async () => {
    testState.createError = new Error("provider unavailable");
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    testState.outcomes.get("security")?.resolve(empty("security"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true, publishSuperseded: false });
    expect(testState.publishOrder).toEqual(["correctness", "summary"]);
    expect(testState.deterministicSummaries[0]?.prCharacter).toContain("Judgment degraded");
  });

  it("returns before returnByMs when session creation crosses modelStopAtMs", async () => {
    vi.useFakeTimers();
    testState.createDelayMs = 200;
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }
    let result: Awaited<ReturnType<typeof runOrchestratedPrReview>> | undefined;
    const run = runOrchestratedPrReview(hardDeadlineParams()).then((value) => {
      result = value;
      return value;
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(result).toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["summary"]);
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(testState.sessionDisposals).toBe(1);
  });

  it("abandons a recon send that ignores abort and finalizes before returnByMs", async () => {
    vi.useFakeTimers();
    testState.sendDelay = { phase: "recon", ms: 200 };
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }
    let result: Awaited<ReturnType<typeof runOrchestratedPrReview>> | undefined;
    const run = runOrchestratedPrReview(hardDeadlineParams()).then((value) => {
      result = value;
      return value;
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(result).toMatchObject({ published: true });
    expect(testState.sessionAborts).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await run;
  });

  it("abandons a judgment send at modelStopAtMs and preserves the report", async () => {
    vi.useFakeTimers();
    testState.sendDelay = { phase: "judgment", ms: 200 };
    let result: Awaited<ReturnType<typeof runOrchestratedPrReview>> | undefined;
    const run = runOrchestratedPrReview(hardDeadlineParams()).then((value) => {
      result = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.advanceTimersByTimeAsync(0);
    testState.outcomes.get("security")?.resolve(empty("security"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await vi.advanceTimersByTimeAsync(100);

    expect(result).toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "summary"]);
    await vi.advanceTimersByTimeAsync(100);
    await run;
  });

  it("abandons synthesis at modelStopAtMs and publishes a deterministic summary", async () => {
    vi.useFakeTimers();
    testState.sendDelay = { phase: "synthesis", ms: 200 };
    let result: Awaited<ReturnType<typeof runOrchestratedPrReview>> | undefined;
    const run = runOrchestratedPrReview(hardDeadlineParams()).then((value) => {
      result = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await vi.advanceTimersByTimeAsync(100);

    expect(result).toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["summary"]);
    await vi.advanceTimersByTimeAsync(100);
    await run;
  });

  it("publishes specialist reports in completion order and the summary last", async () => {
    const run = runOrchestratedPrReview(params());
    await vi.waitFor(() => expect(testState.outcomes.size).toBe(4));
    testState.outcomes.get("quality")?.resolve(report("quality"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["quality"]));
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["quality", "correctness"]));
    testState.outcomes.get("tests")?.resolve(report("tests"));
    await vi.waitFor(() =>
      expect(testState.publishOrder).toEqual(["quality", "correctness", "tests"]),
    );
    testState.outcomes.get("security")?.resolve(report("security"));

    await expect(run).resolves.toMatchObject({ published: true, publishSuperseded: false });
    expect(testState.publishOrder).toEqual([
      "quality",
      "correctness",
      "tests",
      "security",
      "summary",
    ]);
  });

  it("records every successful orchestrator turn and only new thread batches", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });

    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      const run = runOrchestratedPrReview({
        ...params(),
        initialPublishState: { threadCallCount: 8 },
      });
      for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
        testState.outcomes.get(specialist)?.resolve(report(specialist));
        await vi.waitFor(() => expect(testState.publishOrder).toContain(specialist));
      }

      await run;

      expect(snapshotReviewRunMetrics()).toMatchObject({
        modelTurnCount: 6,
        threadBatches: 4,
      });
    });
  });

  it("skips judgment for an empty specialist outcome", async () => {
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness"]));
    testState.outcomes.get("security")?.resolve(report("security"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness", "security"]));
    testState.outcomes.get("tests")?.resolve(report("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "security", "tests", "summary"]);
  });

  it("marks failed specialist coverage partial without running judgment", async () => {
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("security")?.resolve(failed("security"));
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness"]));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "summary"]);
    expect(testState.summaryNotes).toEqual(["Coverage partial: security specialist failed."]);
  });

  it("publishes the failure notice and no summary when every specialist fails", async () => {
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(failed("correctness"));
    testState.outcomes.get("security")?.resolve(failed("security"));
    testState.outcomes.get("quality")?.resolve(failed("quality"));
    testState.outcomes.get("tests")?.resolve(failed("tests"));

    await expect(run).resolves.toMatchObject({ published: false });
    expect(testState.publishOrder).toEqual([]);
    expect(testState.failureNotices).toBe(1);
  });

  it("surfaces specialist insufficient-credits failure as lastFailure on soft-fail", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      const creditMessage = "Insufficient credits for model";
      const run = runOrchestratedPrReview(params());
      testState.outcomes.get("correctness")?.resolve(failed("correctness", creditMessage));
      testState.outcomes.get("security")?.resolve(failed("security", creditMessage));
      testState.outcomes.get("quality")?.resolve(failed("quality", creditMessage));
      testState.outcomes.get("tests")?.resolve(failed("tests", creditMessage));

      const result = await run;
      expect(result).toMatchObject({
        published: false,
        lastFailure: {
          failureDomain: "provider",
          errorKind: "quota",
        },
      });
      expect(result.lastFailure?.errorMessage.toLowerCase()).toContain("credit");
      expect(snapshotReviewRunMetrics()?.lastFailure?.errorKind).toBe("quota");
    });
  });

  it("publishes a deterministic summary when synthesis never calls publish_summary", async () => {
    testState.synthesisPublishesSummary = false;
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness"]));
    testState.outcomes.get("security")?.resolve(empty("security"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true, publishSuperseded: false });
    expect(testState.publishOrder).toEqual(["correctness", "summary"]);
    expect(testState.failureNotices).toBe(0);
    expect(testState.deterministicSummaries).toHaveLength(1);
  });

  it("falls back to a deterministic brief when recon never submits one", async () => {
    testState.reconSubmitsBrief = false;
    const run = runOrchestratedPrReview(params());
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.briefMessages).toHaveLength(4);
    expect(
      testState.briefMessages.every((message) => message.includes("Add orchestrated reviews")),
    ).toBe(true);
  });

  it("degrades current and later reports after two judgment send failures", async () => {
    testState.judgmentFailuresRemaining = 2;
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness"]));
    testState.outcomes.get("security")?.resolve(report("security"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness", "security"]));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "security", "summary"]);
    expect(testState.sessionAborts).toBe(1);
    expect(testState.deterministicSummaries[0]?.prCharacter).toContain("Judgment degraded");
  });

  it("preserves a report when judgment tool restriction throws", async () => {
    testState.restrictionFailureTool = "publish_thread";
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toContain("correctness"));
    testState.outcomes.get("security")?.resolve(report("security"));
    await vi.waitFor(() => expect(testState.publishOrder).toContain("security"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "security", "summary"]);
    expect(testState.deterministicSummaries[0]?.findings).toHaveLength(2);
  });

  it("preserves a report when the run gate throws during outcome handling", async () => {
    let gateChecks = 0;
    const run = runOrchestratedPrReview(
      paramsWithGate(async () => {
        gateChecks += 1;
        if (gateChecks === 2) throw new Error("gate unavailable");
        return { kind: "continue" };
      }),
    );
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness"]));
    testState.outcomes.get("security")?.resolve(report("security"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness", "security"]));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "security", "summary"]);
    expect(testState.deterministicSummaries[0]?.findings).toHaveLength(2);
  });

  it("aborts and joins every provider promise when superseded during the pump", async () => {
    let gateChecks = 0;
    const run = runOrchestratedPrReview({
      ...paramsWithGate(async () => {
        gateChecks += 1;
        return gateChecks === 1 ? { kind: "continue" } : { kind: "stop", reason: "superseded" };
      }),
      recordPublishStep: coordinatedRecordPublishStep(),
    });
    testState.outcomes.get("correctness")?.resolve(report("correctness"));

    await expect(run).resolves.toMatchObject({ published: false, publishSuperseded: true });
    expect([...testState.signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect(testState.publishOrder).toEqual([]);
    expect(testState.sessionDisposals).toBe(1);
    expect(testState.ticks).toEqual([
      { progressRevision: 1, kind: "specialists" },
      { progressRevision: 6, kind: "terminal" },
    ]);
  });

  it("finalizes returned reports deterministically at the model deadline", async () => {
    let gateChecks = 0;
    const run = runOrchestratedPrReview(
      paramsWithGate(async () => {
        gateChecks += 1;
        return gateChecks === 1 ? { kind: "continue" } : { kind: "finalize", reason: "deadline" };
      }),
    );
    testState.outcomes.get("tests")?.resolve(report("tests"));

    await expect(run).resolves.toMatchObject({ published: true, publishSuperseded: false });
    expect(testState.publishOrder).toEqual(["tests", "summary"]);
    expect([...testState.signals.values()].every((signal) => signal.aborted)).toBe(true);
  });

  it("restores before every exact tool restriction", async () => {
    const run = runOrchestratedPrReview(params());
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(report(specialist));
      await vi.waitFor(() => expect(testState.publishOrder).toContain(specialist));
    }
    await run;

    expect(testState.transitions).toEqual([
      ["submit_specialist_brief"],
      ["publish_thread"],
      ["publish_thread"],
      ["publish_thread"],
      ["publish_thread"],
      ["publish_summary"],
    ]);
  });

  it("refreshes live authentication before every model-driven publish and tick", async () => {
    const recordPublishStep = coordinatedRecordPublishStep();
    const run = runOrchestratedPrReview({ ...params(), recordPublishStep });
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(report(specialist));
      await vi.waitFor(() => expect(testState.publishOrder).toContain(specialist));
    }
    await run;

    expect(testState.refreshes).toBe(10);
  });
});
