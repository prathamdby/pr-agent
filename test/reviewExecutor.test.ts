import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { ReviewJobData } from "../src/agentWork/types.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";
import { DESCRIPTION_AGENT_HEADER } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

const mocks = vi.hoisted(() => ({
  loadPublishContext: vi.fn(),
  fetchPrFiles: vi.fn(),
  lightweight: vi.fn(),
  runOrchestratedPrReview: vi.fn(),
  withPrRepositoryView: vi.fn(),
  buildStaleReschedule: vi.fn(),
  buildTrustedContext: vi.fn(),
  fetchPriorFeedback: vi.fn(),
  getAppBotIdentity: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  captureEvent: vi.fn(),
  getSummaryCommentGithubId: vi.fn(async (): Promise<number | null> => null),
  getProgressStubPostedAtMs: vi.fn(async (): Promise<number | null> => null),
  getWorkItem: vi.fn(async (): Promise<unknown> => null),
  recordPublishStep: vi.fn(),
  hasCompletedPublishStep: vi.fn(async () => false),
  shouldSkipWork: vi.fn(async () => false),
  getPullRequestHeadSha: vi.fn(async () => "head"),
  ensureCheckRunStarted: vi.fn(async (): Promise<number | null> => null),
  completeCheckRun: vi.fn(async () => true),
  reviewCheckDetailsUrl: vi.fn(
    (
      _owner: string,
      _repo: string,
      _prNumber: number,
      _summaryCommentId?: string | number | null,
    ): string | undefined => undefined,
  ),
  getSharedRateLimitCircuit: vi.fn(async () => null),
  openSharedRateLimitCircuitBestEffort: vi.fn(),
}));

vi.mock("../src/analytics/index.js", () => ({
  captureEvent: (...args: unknown[]) => mocks.captureEvent(...args),
  captureException: vi.fn(),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  loadReviewExecutorPublishContext: mocks.loadPublishContext,
  recordPublishStep: mocks.recordPublishStep,
  hasCompletedPublishStep: mocks.hasCompletedPublishStep,
  shouldSkipWork: mocks.shouldSkipWork,
  isExecutionEpochCurrent: vi.fn().mockResolvedValue(true),
  getSummaryCommentGithubId: mocks.getSummaryCommentGithubId,
  getProgressStubPostedAtMs: mocks.getProgressStubPostedAtMs,
  getWorkItem: mocks.getWorkItem,
}));

vi.mock("../src/agentWork/reviewCheckRun.js", () => ({
  ensureReviewCheckRunStarted: mocks.ensureCheckRunStarted,
  completeReviewCheckRun: mocks.completeCheckRun,
  reviewCheckDetailsUrl: mocks.reviewCheckDetailsUrl,
}));

vi.mock("../src/review/orchestrator/orchestratorRun.js", () => ({
  runOrchestratedPrReview: mocks.runOrchestratedPrReview,
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
  getPullRequestHead: vi.fn(async () => ({ headSha: "head" })),
  getPullRequestHeadSha: mocks.getPullRequestHeadSha,
}));

vi.mock("../src/github/sharedRateLimitCircuit.js", () => ({
  getSharedRateLimitCircuit: mocks.getSharedRateLimitCircuit,
  openSharedRateLimitCircuitBestEffort: mocks.openSharedRateLimitCircuitBestEffort,
}));

import * as durableJob from "../src/agentWork/durableJob.js";
import * as listPullRequestFiles from "../src/github/listPullRequestFiles.js";
import * as reviewLightweightCompletion from "../src/agentWork/reviewLightweightCompletion.js";
import * as prWorkspace from "../src/prWorkspace/index.js";
import * as reviewTrustedContext from "../src/review/prompts/reviewTrustedContext.js";
import * as reviewReschedule from "../src/agentWork/reviewReschedule.js";
import * as evlog from "../src/evlog.js";
import * as reviewPublish from "../src/github/reviewPublish.js";
import * as reviewRunMetrics from "../src/review/run/reviewRunMetrics.js";
import * as rateLimitCircuit from "../src/github/rateLimitCircuit.js";
import { executeReviewJob } from "../src/agentWork/executors/reviewExecutor.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = {} as Pool;
const boss = {} as PgBoss;
const prFiles = {
  files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }],
  truncated: false,
  omittedCountLowerBound: 0,
  totalChanges: 2,
  headSha: "head",
};
const pullRequest = {
  additions: 1,
  deletions: 1,
  changed_files: 1,
  head: { sha: "head" },
};

function makeItem(source: "auto" | "slash") {
  return makeReviewWorkItem({ source, headSha: "head" });
}

function mockRepositoryView() {
  mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
    run({
      preflight: { preflight: true },
      agentCwd: "/tmp",
      workspace: mockLocalPrWorkspace(),
    }),
  );
}

function defaultCheckoutCoverage() {
  return mockLocalPrWorkspace().getCoverage();
}

function reviewJob(): JobWithMetadata<ReviewJobData> {
  const now = new Date();
  return {
    id: "job-1",
    name: "agent-work-review",
    data: { kind: "review", workItemId: "wi-1" },
    expireInSeconds: 3600,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "active",
    retryLimit: 3,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: now,
    startedOn: now,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 0,
    createdOn: now,
    completedOn: null,
    keepUntil: now,
    policy: "standard",
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: "",
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  };
}

function mockDurableExecution(source: "auto" | "slash" = "slash"): void {
  vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
    const item = makeItem(source);
    await spec.execute(item, {
      installation: {
        token: "tok",
        expiresAtTs: Date.now() + 300_000,
        ttlMs: 300_000,
      },
      headSha: "head",
      executionEpoch: 1,
      signal: new AbortController().signal,
      pullRequest: source === "slash" ? pullRequest : undefined,
    });
  });
}

describe("executeReviewJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSharedRateLimitCircuit.mockResolvedValue(null);
    vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles").mockImplementation(mocks.fetchPrFiles);
    vi.spyOn(reviewLightweightCompletion, "tryLightweightAutoReviewCompletion").mockImplementation(
      mocks.lightweight,
    );
    vi.spyOn(prWorkspace, "withPrRepositoryView").mockImplementation(mocks.withPrRepositoryView);
    vi.spyOn(reviewReschedule, "buildStaleReviewRescheduleResult").mockImplementation(
      mocks.buildStaleReschedule,
    );
    vi.spyOn(reviewTrustedContext, "buildTrustedReviewContextForReview").mockImplementation(
      mocks.buildTrustedContext,
    );
    vi.spyOn(reviewTrustedContext, "fetchPriorInlineFeedbackBlockForReview").mockImplementation(
      mocks.fetchPriorFeedback,
    );
    vi.spyOn(evlog, "logInfo").mockImplementation(mocks.logInfo);
    vi.spyOn(evlog, "logWarn").mockImplementation(mocks.logWarn);
    vi.spyOn(reviewPublish, "upsertReviewSummaryComment").mockResolvedValue({
      id: 1,
      updated: false,
    });
    vi.spyOn(reviewRunMetrics, "initReviewRunMetrics").mockImplementation(() => undefined);
    vi.spyOn(reviewRunMetrics, "logReviewRunCompleted").mockImplementation(() => undefined);
    vi.spyOn(reviewRunMetrics, "setReviewRunMetricFields").mockImplementation(() => undefined);
    vi.spyOn(reviewRunMetrics, "recordReviewPhaseSpan").mockImplementation(async (_phase, run) =>
      run(),
    );
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 1 });
    mocks.loadPublishContext.mockResolvedValue({
      publishState: {
        summaryPublished: false,
        inlineReviewIds: [],
        threadCallCount: 0,
      },
      shouldLinkToSummary: false,
      storedInlineFingerprints: [],
      resumedPlacements: [],
      progressCommentGithubId: null,
    });
    mocks.fetchPrFiles.mockResolvedValue(prFiles);
    mocks.lightweight.mockResolvedValue({ handled: false });
    mocks.runOrchestratedPrReview.mockResolvedValue({
      published: true,
      publishAttempts: 1,
      publishSuperseded: false,
    });
    mocks.buildTrustedContext.mockResolvedValue("trusted");
    mocks.fetchPriorFeedback.mockResolvedValue(undefined);
    mocks.getSummaryCommentGithubId.mockResolvedValue(1);
    mocks.ensureCheckRunStarted.mockResolvedValue(123);
    mocks.completeCheckRun.mockResolvedValue(true);
    mocks.reviewCheckDetailsUrl.mockImplementation(
      (owner: string, repo: string, prNumber: number, summaryCommentId?: string | number | null) =>
        summaryCommentId == null
          ? undefined
          : `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`,
    );
    mockRepositoryView();
    mockDurableExecution("slash");
  });

  it("loads publish context in one batched db-read span", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.loadPublishContext).toHaveBeenCalledTimes(1);
    expect(mocks.loadPublishContext).toHaveBeenCalledWith(pool, "wi-1", "o/r#1", "review");
  });

  it("continues review when shared rate-limit circuit read fails", async () => {
    mocks.getSharedRateLimitCircuit.mockRejectedValueOnce(new Error("db down"));

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runOrchestratedPrReview).toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "github_shared_rate_limit_circuit_read_failed",
      expect.objectContaining({
        type: "review",
        message: "db down",
      }),
    );
  });

  it("records the rate_limit_circuit_opened metric when the review circuit opens", async () => {
    const recordMetric = vi
      .spyOn(reviewRunMetrics, "recordReviewMetric")
      .mockImplementation(() => undefined);
    const realCreate = rateLimitCircuit.createRateLimitCircuit;
    let onOpened: ((kind: "primary" | "secondary") => void) | undefined;
    vi.spyOn(rateLimitCircuit, "createRateLimitCircuit").mockImplementation((params) => {
      onOpened = params.onOpened;
      return realCreate(params);
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    onOpened?.("primary");
    expect(recordMetric).toHaveBeenCalledWith({ kind: "rate_limit_circuit_opened" });
    expect(mocks.openSharedRateLimitCircuitBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lastErrorKind: "primary" }),
    );
  });

  it("passes the resumed thread call count into the review run", async () => {
    mocks.loadPublishContext.mockResolvedValueOnce({
      publishState: {
        summaryPublished: false,
        inlineReviewIds: [41],
        threadCallCount: 8,
      },
      shouldLinkToSummary: false,
      storedInlineFingerprints: [],
      resumedPlacements: [],
      progressCommentGithubId: null,
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPublishState: {
          published: false,
          inlineReviewIds: [41],
          threadCallCount: 8,
        },
      }),
    );
  });

  it("passes the persisted progress comment id into the review run as the hint", async () => {
    mocks.loadPublishContext.mockResolvedValueOnce({
      publishState: {
        summaryPublished: false,
        inlineReviewIds: [],
        threadCallCount: 0,
      },
      shouldLinkToSummary: false,
      storedInlineFingerprints: [],
      resumedPlacements: [],
      progressCommentGithubId: 4321,
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ progressCommentIdHint: 4321 }),
    );
  });

  it("skips preflight for slash reviews", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.fetchPrFiles).not.toHaveBeenCalled();
    expect(mocks.lightweight).not.toHaveBeenCalled();
    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledTimes(1);
    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: "wi-1", resumedPlacements: [] }),
    );
  });

  it("ensures a review check run before the long review", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.ensureCheckRunStarted).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        token: "tok",
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "head",
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
      }),
    );
    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledTimes(1);
  });

  it("passes queue-derived timing and the live review gate to the orchestrator", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    const params = mocks.runOrchestratedPrReview.mock.calls[0]?.[0] as {
      timing: {
        returnByMs: number;
        modelStopAtMs: number;
        remainingModelMs: (now?: number) => number;
        remainingTotalMs: (now?: number) => number;
      };
      gate: { check: () => Promise<{ kind: string }> };
      prTitle: string;
      prBody: string | null;
    };
    expect(params.timing.returnByMs - params.timing.modelStopAtMs).toBe(30_000);
    expect(params.timing.remainingTotalMs(params.timing.returnByMs)).toBe(0);
    expect(params.timing.remainingModelMs(params.timing.modelStopAtMs)).toBe(0);
    await expect(params.gate.check()).resolves.toEqual({ kind: "continue" });
    expect(params.prTitle).toBe("");
    expect(params.prBody).toBeNull();
  });

  it("routes a stale-head gate stop through the existing slash reschedule path", async () => {
    mocks.getPullRequestHeadSha.mockResolvedValueOnce("new-head");
    mocks.runOrchestratedPrReview.mockImplementationOnce(async (params) => {
      const gate = await params.gate.check();
      expect(gate).toEqual({ kind: "stop", reason: "stale_head" });
      return { published: false, publishAttempts: 0, publishSuperseded: true };
    });
    mocks.buildStaleReschedule.mockReturnValue({ rescheduled: true });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildStaleReschedule).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ id: "wi-1" }),
      "tok",
      expect.any(Number),
    );
  });

  it("routes a stale-head gate stop through reschedule for auto reviews", async () => {
    mockDurableExecution("auto");
    mocks.getPullRequestHeadSha.mockResolvedValueOnce("new-head");
    mocks.runOrchestratedPrReview.mockImplementationOnce(async (params) => {
      const gate = await params.gate.check();
      expect(gate).toEqual({ kind: "stop", reason: "stale_head" });
      return { published: false, publishAttempts: 0, publishSuperseded: true };
    });
    mocks.buildStaleReschedule.mockReturnValue({ rescheduled: true });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildStaleReschedule).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ id: "wi-1", source: "auto" }),
      "tok",
      expect.any(Number),
    );
  });

  it("preserves superseded gate stops without checking the pull request head", async () => {
    mocks.shouldSkipWork.mockResolvedValueOnce(true);
    mocks.getWorkItem.mockResolvedValueOnce(
      makeReviewWorkItem({ id: "wi-1", source: "auto", status: "running" }),
    );
    mocks.runOrchestratedPrReview.mockImplementationOnce(async (params) => {
      const gate = await params.gate.check();
      expect(gate).toEqual({ kind: "stop", reason: "superseded" });
      return { published: false, publishAttempts: 0, publishSuperseded: true };
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.getPullRequestHeadSha).not.toHaveBeenCalled();
    expect(mocks.buildStaleReschedule).not.toHaveBeenCalled();
  });

  it("maps slash /cancel into a cancelled gate stop with attribution", async () => {
    mocks.shouldSkipWork.mockResolvedValueOnce(true);
    mocks.getWorkItem.mockResolvedValueOnce(
      makeReviewWorkItem({
        id: "wi-1",
        source: "slash",
        status: "running",
        payload: {
          mode: "review",
          source: "slash",
          cancelAttribution: { kind: "user", login: "alice" },
        },
      }),
    );
    mocks.runOrchestratedPrReview.mockImplementationOnce(async (params) => {
      const gate = await params.gate.check();
      expect(gate).toEqual({
        kind: "stop",
        reason: "cancelled",
        attribution: { kind: "user", login: "alice" },
      });
      return { published: false, publishAttempts: 0, publishSuperseded: true };
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.getPullRequestHeadSha).not.toHaveBeenCalled();
    expect(mocks.buildStaleReschedule).not.toHaveBeenCalled();
    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "cancelled",
      }),
    );
  });

  it("runs auto preflight and lightweight completion before full review", async () => {
    mockDurableExecution("auto");
    mocks.lightweight.mockResolvedValue({ handled: true, published: true });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.fetchPrFiles).toHaveBeenCalledTimes(1);
    expect(mocks.lightweight).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        preflight: {
          files: [{ filename: "src/a.ts" }],
          truncated: false,
          fileCount: 1,
          totalChanges: 2,
        },
      }),
    );
    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runOrchestratedPrReview).not.toHaveBeenCalled();
    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "Documentation-only change set.",
      }),
    );
  });

  it("completes an existing check as failure when publish is exhausted", async () => {
    mocks.runOrchestratedPrReview.mockResolvedValue({
      published: false,
      publishAttempts: 3,
      publishSuperseded: false,
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "failure",
        summary: "PR Agent could not publish a structured review.",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
  });

  it("emits review failed with prior provider credit lastFailure", async () => {
    mocks.runOrchestratedPrReview.mockResolvedValue({
      published: false,
      publishAttempts: 2,
      publishSuperseded: false,
      lastFailure: {
        failureDomain: "provider",
        errorKind: "quota",
        errorMessage: "Insufficient credits for model",
        phase: "synthesis",
      },
      lastAssistant: {
        role: "assistant",
        content: [],
        stopReason: "stop",
        api: "openai-completions",
        provider: "openai",
        model: "m",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        timestamp: 0,
      },
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review failed",
        properties: expect.objectContaining({
          failure_domain: "provider",
          error_kind: "quota",
          error_message: expect.stringMatching(/credit/i),
          publish_attempts: 2,
          provider: "openai",
          model: "test",
        }),
      }),
    );
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "review_not_published",
      expect.objectContaining({
        failureDomain: "provider",
        errorKind: "quota",
      }),
    );
  });

  it("emits review published with formula-B timing props when generationMs > 0", async () => {
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics").mockReturnValue({
      wallClockMs: 200_000,
      providerOutputTokens: 1500,
      generationMs: 50_000,
      providerOutputTps: 30,
      tokenCoverage: "full_run",
      findingsCount: 2,
      severities: ["high"],
    } as unknown as reviewRunMetrics.ReviewRunMetricsSnapshot);

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review published",
        properties: expect.objectContaining({
          wall_clock_ms: 200_000,
          provider_output_tokens: 1500,
          generation_ms: 50_000,
          provider_output_tps: 30,
          token_coverage: "full_run",
          provider: "openai",
          model: "test",
          publish_attempts: 1,
        }),
      }),
    );
  });

  it("omits provider_output_tps on review published when generationMs is 0", async () => {
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics").mockReturnValue({
      wallClockMs: 12_000,
      providerOutputTokens: 100,
      generationMs: 0,
      tokenCoverage: "orchestrator_only",
      findingsCount: 0,
      severities: [],
    } as unknown as reviewRunMetrics.ReviewRunMetricsSnapshot);

    await executeReviewJob(cfg, pool, boss, reviewJob());

    const call = mocks.captureEvent.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === "review published",
    );
    expect(call).toBeDefined();
    const properties = (call?.[0] as { properties: Record<string, unknown> }).properties;
    expect(properties).toMatchObject({
      wall_clock_ms: 12_000,
      provider_output_tokens: 100,
      token_coverage: "orchestrator_only",
    });
    expect(properties).not.toHaveProperty("generation_ms");
    expect(properties).not.toHaveProperty("provider_output_tps");
  });

  it("emits review failed with timing parity props from snapshot", async () => {
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics").mockReturnValue({
      wallClockMs: 190_000,
      providerOutputTokens: 800,
      generationMs: 40_000,
      providerOutputTps: 20,
      tokenCoverage: "full_run",
      toolCallErrors: 1,
      lastFailure: null,
    } as unknown as reviewRunMetrics.ReviewRunMetricsSnapshot);
    mocks.runOrchestratedPrReview.mockResolvedValue({
      published: false,
      publishAttempts: 2,
      publishSuperseded: false,
      lastFailure: {
        failureDomain: "github",
        errorKind: "rate_limit",
        errorMessage: "API rate limit exceeded",
        phase: "publish",
      },
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.captureEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "review failed",
        properties: expect.objectContaining({
          wall_clock_ms: 190_000,
          provider_output_tokens: 800,
          generation_ms: 40_000,
          provider_output_tps: 20,
          token_coverage: "full_run",
          provider: "openai",
          model: "test",
          publish_attempts: 2,
          failure_domain: "github",
          error_kind: "rate_limit",
          tool_call_errors: 1,
        }),
      }),
    );
  });

  it("completes an existing check as cancelled when publish is superseded", async () => {
    mocks.runOrchestratedPrReview.mockResolvedValue({
      published: false,
      publishAttempts: 1,
      publishSuperseded: true,
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "cancelled",
        summary: "Review publish was skipped because the work was superseded or cancelled.",
      }),
    );
  });

  it("completes an existing check as failure from the terminal failure hook", async () => {
    vi.spyOn(reviewPublish, "findIssueCommentBySentinel").mockResolvedValue(null);
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        {
          token: "tok",
          expiresAtTs: Date.now() + 300_000,
          ttlMs: 300_000,
        },
        new Error("dead"),
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "failure",
        summary: "PR Agent could not complete the review after retries.",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
  });

  it("skips failure notice when a summary sentinel already exists on GitHub", async () => {
    vi.spyOn(reviewPublish, "findIssueCommentBySentinel").mockResolvedValue({
      id: 4242,
      url: "https://github.test/comment/4242",
      body: "landed",
    });
    const upsert = vi.spyOn(reviewPublish, "upsertReviewSummaryComment");
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        {
          token: "tok",
          expiresAtTs: Date.now() + 300_000,
          ttlMs: 300_000,
        },
        new Error("dead"),
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(upsert).not.toHaveBeenCalled();
    expect(mocks.completeCheckRun).not.toHaveBeenCalled();
  });

  it("does not overwrite a completed summary from the terminal failure hook", async () => {
    mocks.hasCompletedPublishStep.mockResolvedValueOnce(true);
    const upsert = vi.spyOn(reviewPublish, "upsertReviewSummaryComment");
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        {
          token: "tok",
          expiresAtTs: Date.now() + 300_000,
          ttlMs: 300_000,
        },
        new Error("dead"),
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.hasCompletedPublishStep).toHaveBeenCalledWith(
      pool,
      expect.any(String),
      expect.any(String),
      "review",
      "summary_comment",
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(mocks.completeCheckRun).not.toHaveBeenCalled();
  });

  it("completes an existing check as cancelled from the durable cancellation hook", async () => {
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onCancelled?.(
        makeItem("slash"),
        {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
        },
        "skipped_before_claim",
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "cancelled",
        summary: "Review was cancelled before completion.",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
    expect(mocks.runOrchestratedPrReview).not.toHaveBeenCalled();
  });

  it("passes auto preflight files into repository preparation", async () => {
    mockDurableExecution("auto");

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.fetchPrFiles).toHaveBeenCalledTimes(1);
    expect(mocks.withPrRepositoryView).toHaveBeenCalledTimes(1);
    expect(mocks.withPrRepositoryView.mock.calls[0]?.[0]).toMatchObject({
      prFiles,
    });
  });

  it("passes resolved pull payload into repository preparation", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.withPrRepositoryView).toHaveBeenCalledTimes(1);
    expect(mocks.withPrRepositoryView.mock.calls[0]?.[0]).toMatchObject({
      pullRequest,
    });
  });

  it("fetches prior feedback while the repository view prepares", async () => {
    let releaseRepositoryView!: () => void;
    const repositoryViewPreparing = new Promise<void>((resolve) => {
      releaseRepositoryView = resolve;
    });
    mocks.withPrRepositoryView.mockImplementation(async (_params, run) => {
      await repositoryViewPreparing;
      return run({
        preflight: { preflight: true },
        agentCwd: "/tmp",
        workspace: mockLocalPrWorkspace(),
      });
    });
    mocks.fetchPriorFeedback.mockResolvedValue("prior block");

    const review = executeReviewJob(cfg, pool, boss, reviewJob());

    await vi.waitFor(() => expect(mocks.fetchPriorFeedback).toHaveBeenCalledTimes(1));
    expect(mocks.runOrchestratedPrReview).not.toHaveBeenCalled();

    releaseRepositoryView();
    await review;

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight: { preflight: true },
      priorInlineFeedback: "prior block",
      repoPolicyBlock: undefined,
      agentInstructionFilesBlock: undefined,
      checkoutCoverage: defaultCheckoutCoverage(),
      symbolIndexStatus: { available: false },
      codeIndexStatus: { available: false },
      findingHistoryTrustedBlock: undefined,
    });
  });

  it("logs bot identity failures before rethrowing prior feedback errors", async () => {
    mocks.getAppBotIdentity.mockRejectedValueOnce(new Error("identity unavailable"));

    await expect(executeReviewJob(cfg, pool, boss, reviewJob())).rejects.toThrow(
      "identity unavailable",
    );

    expect(mocks.logWarn).toHaveBeenCalledWith("prior_inline_feedback_fetch_failed", {
      owner: "o",
      repo: "r",
      pr: 1,
      reviewLens: "review",
      message: "identity unavailable",
    });
    expect(mocks.fetchPriorFeedback).not.toHaveBeenCalled();
    expect(mocks.runOrchestratedPrReview).not.toHaveBeenCalled();
  });

  it("continues the review when prior feedback fetch logs and returns undefined", async () => {
    mocks.fetchPriorFeedback.mockImplementationOnce(async (args) => {
      args.onPriorFeedbackError?.(new Error("feedback unavailable"));
      return undefined;
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.logWarn).toHaveBeenCalledWith("prior_inline_feedback_fetch_failed", {
      owner: "o",
      repo: "r",
      pr: 1,
      reviewLens: "review",
      message: "feedback unavailable",
    });
    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight: { preflight: true },
      priorInlineFeedback: undefined,
      repoPolicyBlock: undefined,
      agentInstructionFilesBlock: undefined,
      checkoutCoverage: defaultCheckoutCoverage(),
      symbolIndexStatus: { available: false },
      codeIndexStatus: { available: false },
      findingHistoryTrustedBlock: undefined,
    });
    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledTimes(1);
  });

  it("rethrows unexpected prior feedback helper rejections", async () => {
    mocks.fetchPriorFeedback.mockRejectedValueOnce(new Error("feedback blew up"));

    await expect(executeReviewJob(cfg, pool, boss, reviewJob())).rejects.toThrow(
      "feedback blew up",
    );

    expect(mocks.logWarn).toHaveBeenCalledWith("prior_inline_feedback_fetch_failed", {
      owner: "o",
      repo: "r",
      pr: 1,
      reviewLens: "review",
      message: "feedback blew up",
    });
    expect(mocks.runOrchestratedPrReview).not.toHaveBeenCalled();
  });

  it("appends rendered repo policy to trusted context when .mdc rules are present", async () => {
    const policyDir = await mkdtemp(join(tmpdir(), "repo-policy-exec-"));
    await mkdir(join(policyDir, ".pr-agent"));
    await writeFile(join(policyDir, ".pr-agent", "tone.mdc"), "Be terse.\n", "utf8");
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 2,
    };
    mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        preflight,
        agentCwd: policyDir,
        workspace: mockLocalPrWorkspace(policyDir),
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight,
      priorInlineFeedback: undefined,
      repoPolicyBlock: expect.stringContaining("Be terse."),
      agentInstructionFilesBlock: undefined,
      checkoutCoverage: mockLocalPrWorkspace(policyDir).getCoverage(),
      symbolIndexStatus: { available: false },
      codeIndexStatus: { available: false },
      findingHistoryTrustedBlock: undefined,
    });
  });

  it("leaves trusted context unchanged when repo policy directory is absent", async () => {
    const policyDir = await mkdtemp(join(tmpdir(), "repo-policy-absent-"));
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 2,
    };
    mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        preflight,
        agentCwd: policyDir,
        workspace: mockLocalPrWorkspace(policyDir),
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight,
      priorInlineFeedback: undefined,
      repoPolicyBlock: undefined,
      agentInstructionFilesBlock: undefined,
      checkoutCoverage: mockLocalPrWorkspace(policyDir).getCoverage(),
      symbolIndexStatus: { available: false },
      codeIndexStatus: { available: false },
      findingHistoryTrustedBlock: undefined,
    });
  });

  it("appends rendered agent instruction files to trusted context when present", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "agent-instruction-exec-"));
    await writeFile(join(checkout, "AGENTS.md"), "Prefer nub install.\n", "utf8");
    const preflight = {
      files: [{ filename: "src/a.ts" }],
      truncated: false,
      fileCount: 1,
      totalChanges: 2,
    };
    mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        preflight,
        agentCwd: checkout,
        workspace: mockLocalPrWorkspace(checkout),
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight,
      priorInlineFeedback: undefined,
      repoPolicyBlock: undefined,
      agentInstructionFilesBlock: expect.stringContaining("Prefer nub install."),
      checkoutCoverage: mockLocalPrWorkspace(checkout).getCoverage(),
      symbolIndexStatus: { available: false },
      codeIndexStatus: { available: false },
      findingHistoryTrustedBlock: undefined,
    });
  });

  it("threads hasDescriptionReviewMap false when PR body lacks a review map section", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ hasDescriptionReviewMap: false }),
    );
  });

  it("threads hasDescriptionReviewMap false when description block has no review map", async () => {
    const prWithDescriptionOnly = {
      ...pullRequest,
      body: `Intro\n\n${DESCRIPTION_AGENT_HEADER}\n\n### PR Type\n\nEnhancement`,
    };
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.execute(makeItem("slash"), {
        installation: {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
        },
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
        pullRequest: prWithDescriptionOnly,
      });
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ hasDescriptionReviewMap: false }),
    );
  });

  it("threads hasDescriptionReviewMap true when PR body contains a review map section", async () => {
    const prWithDescription = {
      ...pullRequest,
      body: `Intro\n\n${DESCRIPTION_AGENT_HEADER}\n\n### PR Type\n\nEnhancement\n\n### Review map\n\n1. \`src/a.ts\`: risk surface`,
    };
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.execute(makeItem("slash"), {
        installation: {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
        },
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
        pullRequest: prWithDescription,
      });
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ hasDescriptionReviewMap: true }),
    );
  });
});
