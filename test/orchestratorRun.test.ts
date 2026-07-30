import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import type { LocalPrWorkspace } from "../src/prWorkspace/index.js";
import { buildCheckoutCoverage } from "../src/prWorkspace/localPrWorkspace.js";
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
import { REVIEW_ACTIVE_BUDGET_MS, REVIEW_FINALIZATION_WINDOW_MS } from "../src/settings/index.js";
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
  specialistTimeouts: [] as number[],
  signals: new Map<string, AbortSignal>(),
  deterministicSummaries: [] as Array<Record<string, unknown>>,
  deterministicSummaryDelayMs: 0,
  deterministicCiAuthors: [] as Array<unknown>,
  ticks: [] as Array<{
    readonly progressRevision: number;
    readonly kind: string;
    readonly recon?: string;
    readonly budget?: { budgetKey: string; limitMs: number; usedMs: number };
    readonly specialists?: Record<
      string,
      { phase: string; budget?: { budgetKey: string; limitMs: number; usedMs: number } }
    >;
  }>,
  publishedBatchCount: 0,
}));

const evidenceState = vi.hoisted(() => {
  type Read = {
    path: string;
    startLine?: number;
    endLine?: number;
    contentHash: string;
    headSha: string;
    tool: string;
    recordedAt?: string;
  };
  function makeLedger(headSha: string) {
    const reads: Read[] = [];
    return {
      headSha,
      record(read: Omit<Read, "recordedAt">) {
        reads.push({ ...read, recordedAt: new Date().toISOString() });
      },
      covers() {
        return true;
      },
      snapshot() {
        return [...reads];
      },
    };
  }
  let ledger = makeLedger("a".repeat(40));
  return {
    reset() {
      ledger = makeLedger("a".repeat(40));
    },
    get() {
      return ledger;
    },
  };
});

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
    evidenceLedger: evidenceState.get(),
    getToken: () => "token",
    getTokenExpiresAtTs: () => Date.now() + 60_000,
    refreshBeforeTool: vi.fn(async () => undefined),
    refreshLiveAuth: vi.fn(async () => {
      testState.refreshes += 1;
    }),
  })),
}));

vi.mock("../src/review/orchestrator/changedFilePass.js", () => ({
  runChangedFilePass: vi.fn(
    async (params: {
      readonly workspace: { readonly changedFiles: readonly { readonly path: string }[] };
      readonly evidenceLedger: {
        record: (read: {
          path: string;
          startLine?: number;
          endLine?: number;
          contentHash: string;
          headSha: string;
          tool: string;
        }) => void;
      };
      readonly headSha: string;
      readonly shouldContinue: () => boolean;
    }) => {
      const paths = params.workspace.changedFiles.map((file) => file.path);
      let attempted = 0;
      const unread: string[] = [];
      for (const path of paths) {
        if (!params.shouldContinue()) {
          unread.push(...paths.slice(attempted));
          return {
            attemptedPathCount: attempted,
            inspectedPathCount: attempted,
            boundedFailures: [],
            unreadPaths: unread,
            stoppedForBudget: true,
          };
        }
        params.evidenceLedger.record({
          path,
          startLine: 1,
          endLine: 1,
          contentHash: "file-pass",
          headSha: params.headSha,
          tool: "server_changed_file_pass",
        });
        attempted += 1;
      }
      return {
        attemptedPathCount: attempted,
        inspectedPathCount: attempted,
        boundedFailures: [],
        unreadPaths: [],
        stoppedForBudget: false,
      };
    },
  ),
}));

vi.mock("../src/review/orchestrator/specialistRun.js", () => ({
  runSpecialist: vi.fn(
    (params: {
      readonly specialist: SpecialistId;
      readonly briefMessage: string;
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
    }) => {
      const outcome = testState.outcomes.get(params.specialist);
      if (!outcome) throw new Error(`Missing ${params.specialist} outcome`);
      testState.briefMessages.push(params.briefMessage);
      testState.specialistTimeouts.push(params.timeoutMs);
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

vi.mock("../src/review/orchestrator/stubTick.js", () => ({
  tickProgressComment: vi.fn(
    async (params: {
      progressRevision: number;
      tickState: {
        kind: string;
        recon?: string;
        specialists?: Record<
          string,
          { phase: string; budget?: { budgetKey: string; limitMs: number; usedMs: number } }
        >;
        budget?: { budgetKey: string; limitMs: number; usedMs: number };
      };
      refreshLiveAuth?: () => Promise<void>;
    }) => {
      await params.refreshLiveAuth?.();
      testState.ticks.push({
        progressRevision: params.progressRevision,
        kind: params.tickState.kind,
        recon: params.tickState.recon,
        specialists: params.tickState.specialists,
        ...(params.tickState.budget == null ? {} : { budget: params.tickState.budget }),
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
  publishReviewSummaryOnly: vi.fn(
    async (params: {
      readonly payload: Record<string, unknown>;
      readonly ciAuthor?: unknown;
      readonly coverage?: ReviewCoverage;
      readonly getCoverage?: () => ReviewCoverage;
    }) => {
      if (testState.deterministicSummaryDelayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, testState.deterministicSummaryDelayMs),
        );
      }
      testState.publishOrder.push("summary");
      testState.deterministicSummaries.push(params.payload);
      testState.deterministicCiAuthors.push(params.ciAuthor);
      const coverage = params.getCoverage?.() ?? params.coverage;
      testState.summaryNotes.push(coverage?.kind === "partial" ? coverage.note : undefined);
      return { kind: "published", summaryCommentId: 10 };
    },
  ),
}));

const runner = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("../src/agent/runtime/createFeatureSession.js", () => ({
  createFeaturePiSession: runner.createSession,
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
  getCoverage: () =>
    buildCheckoutCoverage({
      checkoutMode: "full",
      checkoutPaths: new Set(),
      changedFiles: [],
      stats: { truncated: false },
    }),
  noteSearchTruncated: () => undefined,
  lookupSymbol: () => [],
  getSymbolIndexStatus: () => ({ available: false }),
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

function report(specialist: SpecialistId): Extract<SpecialistOutcome, { readonly kind: "report" }> {
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

function timedOut(specialist: SpecialistId): SpecialistOutcome {
  return {
    kind: "error",
    specialist,
    durationMs: 480_010,
    error: new AppError({
      code: "review.specialist_failed",
      message: `${specialist} timed out`,
      context: {
        budgetKey: "REVIEW_SPECIALIST_TIMEOUT_MS",
        limitMs: 480_000,
        usedMs: 480_010,
      },
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

describe("runOrchestratedPrReview", () => {
  beforeEach(() => {
    runner.createSession.mockClear();
    evidenceState.reset();
    testState.outcomes.clear();
    testState.publishOrder.length = 0;
    testState.activeSource = null;
    testState.summaryNotes.length = 0;
    testState.failureNotices = 0;
    testState.refreshes = 0;
    testState.briefMessages.length = 0;
    testState.specialistTimeouts.length = 0;
    testState.signals.clear();
    testState.deterministicSummaries.length = 0;
    testState.deterministicSummaryDelayMs = 0;
    testState.deterministicCiAuthors.length = 0;
    testState.ticks.length = 0;
    testState.publishedBatchCount = 0;
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.set(specialist, deferred());
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    evlog.initEvlog("error", { silent: true, suppressDrainWarning: true });
  });

  it("caps every normal specialist at eight minutes", async () => {
    const base = params();
    const deadline = Date.now() + 20 * 60_000;
    const run = runOrchestratedPrReview({
      ...base,
      cfg: { ...base.cfg, reviewSpecialistTimeoutMs: 900_000 },
      tokenExpiresAtTs: deadline,
      timing: {
        returnByMs: deadline,
        modelStopAtMs: deadline,
        remainingModelMs: () => 20 * 60_000,
        remainingTotalMs: () => 20 * 60_000,
      },
    });
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await run;
    expect(testState.specialistTimeouts).toEqual([480_000, 480_000, 480_000, 480_000]);
  });

  it("uses deterministic bookends without creating an orchestrator session", async () => {
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    testState.outcomes.get("security")?.resolve(empty("security"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true, publishSuperseded: false });
    expect(testState.publishOrder).toEqual(["correctness", "summary"]);
    expect(testState.deterministicSummaries[0]?.prCharacter).toContain(
      "orchestrated review completed",
    );
    expect(runner.createSession).not.toHaveBeenCalled();
    expect(typeof testState.deterministicCiAuthors[0]).toBe("function");
  });

  it("publishes an all-empty run without model-authored bookends", async () => {
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }
    await expect(runOrchestratedPrReview(params())).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["summary"]);
    expect(runner.createSession).not.toHaveBeenCalled();
  });

  it("reserves finalization time and publishes named partial coverage", async () => {
    vi.useFakeTimers();
    const run = runOrchestratedPrReview({
      ...params(),
      recordPublishStep: coordinatedRecordPublishStep(),
    });
    await vi.advanceTimersByTimeAsync(REVIEW_ACTIVE_BUDGET_MS);
    const result = await run;

    expect(result).toMatchObject({ published: true });
    expect(testState.failureNotices).toBe(0);
    expect(testState.summaryNotes[0]).toContain("model_window");
    expect(testState.summaryNotes[0]).toContain(
      `limit ${REVIEW_ACTIVE_BUDGET_MS - REVIEW_FINALIZATION_WINDOW_MS} ms`,
    );
    expect(testState.ticks.some((tick) => tick.budget?.budgetKey === "model_window")).toBe(true);
  });

  it("does not report full coverage when finalization reaches the active deadline", async () => {
    vi.useFakeTimers();
    testState.deterministicSummaryDelayMs = REVIEW_ACTIVE_BUDGET_MS;
    const run = runOrchestratedPrReview({
      ...params(),
      recordPublishStep: coordinatedRecordPublishStep(),
    });
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REVIEW_ACTIVE_BUDGET_MS);

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.summaryNotes[0]).toContain("Coverage partial");
    expect(testState.summaryNotes[0]).toContain("REVIEW_ACTIVE_BUDGET_MS");
    expect(
      testState.ticks.some((tick) => tick.budget?.budgetKey === "REVIEW_ACTIVE_BUDGET_MS"),
    ).toBe(true);
  });

  it("uses the reserved finalization window without marking completed coverage partial", async () => {
    vi.useFakeTimers();
    testState.deterministicSummaryDelayMs =
      REVIEW_ACTIVE_BUDGET_MS - REVIEW_FINALIZATION_WINDOW_MS / 2;
    const run = runOrchestratedPrReview(params());
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(testState.deterministicSummaryDelayMs);

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.summaryNotes).toEqual([undefined]);
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

  it("derives deterministic security concerns from accepted security findings", async () => {
    const securityReport = report("security");
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("security")?.resolve(securityReport);
    testState.outcomes.get("correctness")?.resolve(empty("correctness"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await run;
    expect(testState.deterministicSummaries[0]?.securityConcerns).toContain("security finding");
  });

  it("derives security concerns from a non-security specialist security category finding", async () => {
    const correctnessReport = report("correctness");
    const securityFinding = correctnessReport.report.findings[0];
    if (securityFinding == null) throw new Error("missing correctness finding fixture");
    securityFinding.category = "security";
    securityFinding.title = "Auth bypass via missing claim check";
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(correctnessReport);
    testState.outcomes.get("security")?.resolve(empty("security"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await run;
    expect(testState.deterministicSummaries[0]?.securityConcerns).toContain(
      "Auth bypass via missing claim check",
    );
  });

  it("publishes a deterministic partial summary when every specialist times out", async () => {
    const run = runOrchestratedPrReview(params());
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(timedOut(specialist));
    }

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.failureNotices).toBe(0);
    expect(testState.summaryNotes[0]).toContain("REVIEW_SPECIALIST_TIMEOUT_MS");
  });

  it("reports full coverage when the server file pass read every changed path in budget", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      const base = params();
      const run = runOrchestratedPrReview({
        ...base,
        workspace: {
          ...workspace,
          changedFiles: [
            { path: "src/a.ts", status: "modified" },
            { path: "README.md", status: "modified" },
          ],
        },
      });
      for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
        testState.outcomes.get(specialist)?.resolve(empty(specialist));
      }

      await run;

      expect(testState.summaryNotes[0]).toBeUndefined();
      expect(snapshotReviewRunMetrics()).toMatchObject({
        partialCoverage: false,
        inspectedPathCount: 2,
        changedPathCount: 2,
        skippedPathCount: 0,
      });
    });
  });

  it("marks unfinished file-pass coverage partial without path inventory dump", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      const { runChangedFilePass } = await import("../src/review/orchestrator/changedFilePass.js");
      vi.mocked(runChangedFilePass).mockImplementationOnce(async (params) => {
        return {
          attemptedPathCount: 0,
          inspectedPathCount: 0,
          boundedFailures: [],
          unreadPaths: params.workspace.changedFiles.map((file) => file.path),
          stoppedForBudget: true,
        };
      });

      const base = params();
      const run = runOrchestratedPrReview({
        ...base,
        workspace: {
          ...workspace,
          changedFiles: [{ path: "src/uninspected.ts", status: "modified" }],
        },
      });
      for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
        testState.outcomes.get(specialist)?.resolve(empty(specialist));
      }

      await run;

      const note = testState.summaryNotes[0] ?? "";
      expect(note).toContain("active review budget ended the run");
      expect(note).not.toContain("Aggregate inspected coverage");
      expect(note).not.toContain("Inspected paths:");
      expect(note).not.toContain("Skipped paths:");
      expect(snapshotReviewRunMetrics()).toMatchObject({
        partialCoverage: true,
        skippedPathCount: 1,
      });
    });
  });

  it("cannot report full coverage when changed paths remain unread in budget", async () => {
    evlog.initEvlog("info", { silent: true, suppressDrainWarning: true });
    await evlog.runWithOperationLogger({ method: "JOB", path: "/review" }, async () => {
      const { runChangedFilePass } = await import("../src/review/orchestrator/changedFilePass.js");
      vi.mocked(runChangedFilePass).mockImplementationOnce(async () => ({
        attemptedPathCount: 0,
        inspectedPathCount: 0,
        boundedFailures: [],
        unreadPaths: ["src/missed.ts"],
        stoppedForBudget: false,
      }));

      const base = params();
      const run = runOrchestratedPrReview({
        ...base,
        workspace: {
          ...workspace,
          changedFiles: [{ path: "src/missed.ts", status: "modified" }],
        },
      });
      for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
        testState.outcomes.get(specialist)?.resolve(empty(specialist));
      }

      await run;

      const note = testState.summaryNotes[0] ?? "";
      expect(note).toContain("not every changed path was inspected");
      expect(note).toContain("1 changed path unread");
      expect(note).toContain("src/missed.ts");
      expect(note).not.toContain("Aggregate inspected coverage");
      expect(note).not.toContain("Inspected paths:");
      expect(snapshotReviewRunMetrics()?.partialCoverage).toBe(true);
    });
  });

  it("publishes thread batches without orchestrator model turns", async () => {
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
        modelTurnCount: 0,
        threadBatches: 4,
        promptProfile: "normal",
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
    expect(testState.summaryNotes[0]).not.toContain("Aggregate inspected coverage");
    expect(testState.summaryNotes[0]).not.toContain("Inspected paths:");
  });

  it("carries specialist timeout receipts into final partial coverage", async () => {
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("security")?.resolve(timedOut("security"));
    testState.outcomes.get("correctness")?.resolve(empty("correctness"));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.summaryNotes[0]).toContain("REVIEW_SPECIALIST_TIMEOUT_MS");
    expect(testState.summaryNotes[0]).toContain("limit 480000 ms");
    expect(testState.summaryNotes[0]).toContain("used 480010 ms");
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

  it("publishes a deterministic summary from the accepted ledger", async () => {
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
    expect(typeof testState.deterministicCiAuthors[0]).toBe("function");
  });

  it("builds the specialist brief deterministically", async () => {
    const run = runOrchestratedPrReview(params());
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.briefMessages).toHaveLength(4);
    expect(
      testState.briefMessages.every((message) => message.includes("Add orchestrated reviews")),
    ).toBe(true);
    expect(
      testState.briefMessages.every((message) => message.includes('<pr_intent untrusted="true">')),
    ).toBe(true);
  });

  it("includes slash review instructions as untrusted specialist context", async () => {
    const run = runOrchestratedPrReview({
      ...params(),
      userSupplement: "Focus on the cache invalidation path.",
    });
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await run;

    expect(
      testState.briefMessages.every(
        (message) =>
          message.includes('<user_supplement untrusted="true">') &&
          message.includes("Focus on the cache invalidation path."),
      ),
    ).toBe(true);
  });

  it("preserves binding context at the end of a long deterministic brief", async () => {
    const bindingRule = "Trusted context (agent instruction files): never skip auth checks.";
    const run = runOrchestratedPrReview({
      ...params(),
      trustedContext: `${"path profile\n".repeat(700)}${bindingRule}`,
    });
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await run;
    expect(testState.briefMessages).toHaveLength(4);
    expect(testState.briefMessages.every((message) => message.includes(bindingRule))).toBe(true);
  });

  it("preserves middle trusted instructions when a user supplement is present", async () => {
    const middleRule = "MIDDLE_BINDING_RULE: always verify installation scopes.";
    const trustedContext = `${"prefix note\n".repeat(80)}${middleRule}\n${"suffix note\n".repeat(80)}`;
    const run = runOrchestratedPrReview({
      ...params(),
      trustedContext,
      userSupplement: "x".repeat(4500),
    });
    for (const specialist of ["correctness", "security", "quality", "tests"] as const) {
      testState.outcomes.get(specialist)?.resolve(empty(specialist));
    }

    await run;
    expect(testState.briefMessages.every((message) => message.includes(middleRule))).toBe(true);
  });

  it("does not invoke judgment while publishing specialist reports", async () => {
    const run = runOrchestratedPrReview(params());
    testState.outcomes.get("correctness")?.resolve(report("correctness"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness"]));
    testState.outcomes.get("security")?.resolve(report("security"));
    await vi.waitFor(() => expect(testState.publishOrder).toEqual(["correctness", "security"]));
    testState.outcomes.get("quality")?.resolve(empty("quality"));
    testState.outcomes.get("tests")?.resolve(empty("tests"));

    await expect(run).resolves.toMatchObject({ published: true });
    expect(testState.publishOrder).toEqual(["correctness", "security", "summary"]);
    expect(testState.deterministicSummaries[0]?.prCharacter).toContain(
      "orchestrated review completed",
    );
    expect(runner.createSession).not.toHaveBeenCalled();
    expect(typeof testState.deterministicCiAuthors[0]).toBe("function");
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
    const run = runOrchestratedPrReview({
      ...paramsWithGate(async () => ({ kind: "stop", reason: "superseded" })),
      recordPublishStep: coordinatedRecordPublishStep(),
    });
    testState.outcomes.get("correctness")?.resolve(report("correctness"));

    await expect(run).resolves.toMatchObject({ published: false, publishSuperseded: true });
    expect([...testState.signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect(testState.publishOrder).toEqual([]);
    expect(testState.ticks).toEqual([
      {
        progressRevision: 1,
        kind: "specialists",
        recon: "done",
        specialists: {
          correctness: { phase: "running" },
          security: { phase: "running" },
          quality: { phase: "running" },
          tests: { phase: "running" },
        },
      },
      {
        progressRevision: 6,
        kind: "terminal",
        recon: "done",
        specialists: {
          correctness: { phase: "running" },
          security: { phase: "running" },
          quality: { phase: "running" },
          tests: { phase: "running" },
        },
      },
    ]);
  });

  it("finalizes returned reports deterministically at the model deadline", async () => {
    const run = runOrchestratedPrReview(
      paramsWithGate(async () => ({ kind: "finalize", reason: "deadline" })),
    );
    testState.outcomes.get("tests")?.resolve(report("tests"));

    await expect(run).resolves.toMatchObject({ published: true, publishSuperseded: false });
    expect(testState.publishOrder).toEqual(["tests", "summary"]);
    expect([...testState.signals.values()].every((signal) => signal.aborted)).toBe(true);
    expect(testState.summaryNotes[0]).toContain("model_window");
    expect(testState.summaryNotes[0]).toMatch(/model_window enforced \(limit [1-9]\d{0,4} ms/);
    expect(testState.summaryNotes[0]).not.toContain(
      `limit ${REVIEW_ACTIVE_BUDGET_MS - REVIEW_FINALIZATION_WINDOW_MS} ms`,
    );
  });

  it("refreshes live authentication before every deterministic publish and tick", async () => {
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
