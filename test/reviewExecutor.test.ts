import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import type { ReviewJobData } from "../src/agentWork/types.js";
import { makeReviewWorkItem } from "./helpers/agentWorkItems.js";
import { DESCRIPTION_AGENT_HEADER } from "../src/settings/index.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import {
  createFakePrSurface,
  resetCreatePrSurface,
  setCreatePrSurface,
  type FakePrSurfaceEvent,
} from "../src/github/prSurface.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

let durableSurfaceBundle = createFakePrSurface(
  { owner: "o", repo: "r", prNumber: 1 },
  { headSha: "head" },
);

import * as durableJob from "../src/agentWork/durableJob.js";
import type { DurableJobSpec } from "../src/agentWork/durableJob.js";
import * as analytics from "../src/analytics/index.js";
import * as repo from "../src/agentWork/repository.js";
import * as orchestratorRun from "../src/review/orchestrator/orchestratorRun.js";
import * as appAuth from "../src/github/appAuth.js";
import * as sharedRateLimitCircuit from "../src/github/sharedRateLimitCircuit.js";
import type { CaptureEventInput } from "../src/analytics/types.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";
import type { OrchestratedReviewRunParams } from "../src/review/orchestrator/orchestratorRun.js";
import type { ReviewRunResult } from "../src/review/run/reviewRunTypes.js";
import { assistantFromText } from "../src/agentRun/sessionHelpers.js";
import { makeAskWorkItem } from "./helpers/agentWorkItems.js";
import { coreOf } from "./helpers/executorDurableHarness.js";
import { DEFERRED_HEAD_SHA } from "../src/settings/index.js";
import * as listPullRequestFiles from "../src/github/listPullRequestFiles.js";
import * as reviewLightweightCompletion from "../src/agentWork/reviewLightweightCompletion.js";
import * as prWorkspace from "../src/prWorkspace/index.js";
import * as reviewTrustedContext from "../src/review/prompts/reviewTrustedContext.js";
import * as reviewReschedule from "../src/agentWork/reviewReschedule.js";
import * as evlog from "../src/evlog.js";
import * as reviewPublish from "../src/github/reviewPublish.js";
import * as reviewRunMetrics from "../src/review/run/reviewRunMetrics.js";
import * as rateLimitCircuit from "../src/github/rateLimitCircuit.js";
import * as reviewCheckRun from "../src/agentWork/reviewCheckRun.js";
import { executeReviewJob } from "../src/agentWork/executors/reviewExecutor.js";

const spies = {
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
  captureEvent: vi.fn((_input: CaptureEventInput) => undefined),
  getSummaryCommentGithubId: vi.fn(async (): Promise<number | null> => null),
  getProgressStubPostedAtMs: vi.fn(async (): Promise<number | null> => null),
  getWorkItem: vi.fn(async (): Promise<AgentWorkItem | null> => null),
  recordPublishStep: vi.fn(),
  hasCompletedPublishStep: vi.fn(async () => false),
  shouldSkipWork: vi.fn(async () => false),
  getSharedRateLimitCircuit: vi.fn(async () => null),
  openSharedRateLimitCircuitBestEffort: vi.fn(),
};

const cfg = makeTestConfig({ piModel: "test" });
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const boss = new PgBoss({ connectionString: "postgres://127.0.0.1:1/unused" });
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

function reviewRunResult(overrides: Partial<ReviewRunResult> = {}): ReviewRunResult {
  return {
    lastAssistant: assistantFromText(cfg, "", cfg.piProvider),
    published: true,
    publishAttempts: 1,
    publishSuperseded: false,
    ...overrides,
  };
}

function metricsSnapshot(
  overrides: Partial<reviewRunMetrics.ReviewRunMetricsSnapshot> = {},
): reviewRunMetrics.ReviewRunMetricsSnapshot {
  return {
    provider: "openai",
    model: "test",
    mode: "review",
    startedAtMs: 0,
    published: true,
    publishAttempts: 1,
    submitCallCount: 0,
    validationFailureCount: 0,
    validationFailureKinds: {},
    coercionsApplied: {},
    toolInputRepairs: {},
    anchorFailureCount: 0,
    anchorFailureFiles: [],
    proseOnlyCollapsesByPhase: {},
    phaseRoundCounts: {},
    phaseSpansMs: {},
    rateLimitCircuitOpened: false,
    tokenNearExpiryGuardHits: 0,
    diffCacheEmptyAtFirstSubmit: false,
    toolCallCount: 0,
    toolCallErrors: 0,
    lastFailure: null,
    recentToolErrors: [],
    toolResultBytes: 0,
    toolResultCharacters: 0,
    modelTurnCount: 0,
    promptBytes: 0,
    promptCharacters: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    cacheHitRate: null,
    cacheWriteAmplification: null,
    estimatedTurnCount: 0,
    findingsCount: 0,
    severities: [],
    wallClockMs: 0,
    specialistOutcomes: {},
    threadBatches: 0,
    briefFallback: false,
    providerSendMs: 0,
    toolMs: 0,
    generationMs: 0,
    tokenCoverage: "orchestrator_only",
    ...overrides,
  };
}

function mockRepositoryView() {
  spies.withPrRepositoryView.mockImplementation(async (_params, run) =>
    run({
      preflight: { files: [], truncated: false, fileCount: 0, totalChanges: 0 },
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

function mockAutoPrFiles(surface = durableSurfaceBundle.surface) {
  return vi.spyOn(surface, "listChangedFiles").mockResolvedValue(prFiles);
}

function mockDurableExecution(source: "auto" | "slash" = "slash"): void {
  durableSurfaceBundle = createFakePrSurface(
    { owner: "o", repo: "r", prNumber: 1 },
    { headSha: "head" },
  );
  setCreatePrSurface(() => durableSurfaceBundle.surface);
  if (source === "auto") {
    mockAutoPrFiles();
  }
  vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
    const item = makeItem(source);
    await spec.execute(item, {
      prSurface: durableSurfaceBundle.surface,
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
    durableSurfaceBundle = createFakePrSurface(
      { owner: "o", repo: "r", prNumber: 1 },
      { headSha: "head" },
    );
    setCreatePrSurface(() => durableSurfaceBundle.surface);
    vi.spyOn(analytics, "captureEvent").mockImplementation(spies.captureEvent);
    vi.spyOn(analytics, "captureException").mockImplementation(() => undefined);
    vi.spyOn(repo, "loadReviewExecutorPublishContext").mockImplementation(spies.loadPublishContext);
    vi.spyOn(repo, "recordPublishStep").mockImplementation(spies.recordPublishStep);
    vi.spyOn(repo, "hasCompletedPublishStep").mockImplementation(spies.hasCompletedPublishStep);
    vi.spyOn(repo, "shouldSkipWork").mockImplementation(spies.shouldSkipWork);
    vi.spyOn(repo, "isExecutionEpochCurrent").mockResolvedValue(true);
    vi.spyOn(repo, "getSummaryCommentGithubId").mockImplementation(spies.getSummaryCommentGithubId);
    vi.spyOn(repo, "getProgressStubPostedAtMs").mockImplementation(spies.getProgressStubPostedAtMs);
    vi.spyOn(repo, "getWorkItem").mockImplementation(spies.getWorkItem);
    vi.spyOn(orchestratorRun, "runOrchestratedPrReview").mockImplementation(
      spies.runOrchestratedPrReview,
    );
    vi.spyOn(appAuth, "getAppBotIdentity").mockImplementation(spies.getAppBotIdentity);
    vi.spyOn(sharedRateLimitCircuit, "getSharedRateLimitCircuit").mockImplementation(
      spies.getSharedRateLimitCircuit,
    );
    vi.spyOn(sharedRateLimitCircuit, "openSharedRateLimitCircuitBestEffort").mockImplementation(
      spies.openSharedRateLimitCircuitBestEffort,
    );
    vi.spyOn(reviewCheckRun, "ensureReviewCheckRunStarted").mockResolvedValue(123);
    vi.spyOn(reviewCheckRun, "completeReviewCheckRun").mockResolvedValue(true);
    vi.spyOn(reviewCheckRun, "cancelReviewCheckRun").mockResolvedValue(true);
    vi.spyOn(reviewCheckRun, "reviewCheckDetailsUrl").mockImplementation(
      (owner: string, repo: string, prNumber: number, summaryCommentId?: string | number | null) =>
        summaryCommentId == null
          ? undefined
          : `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`,
    );
    spies.getSharedRateLimitCircuit.mockResolvedValue(null);
    vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles").mockImplementation(spies.fetchPrFiles);
    vi.spyOn(reviewLightweightCompletion, "tryLightweightAutoReviewCompletion").mockImplementation(
      spies.lightweight,
    );
    vi.spyOn(prWorkspace, "withPrRepositoryView").mockImplementation(spies.withPrRepositoryView);
    vi.spyOn(reviewReschedule, "tryBuildStaleReviewRescheduleResult").mockImplementation(
      spies.buildStaleReschedule,
    );
    vi.spyOn(reviewTrustedContext, "buildTrustedReviewContextForReview").mockImplementation(
      spies.buildTrustedContext,
    );
    vi.spyOn(reviewTrustedContext, "fetchPriorInlineFeedbackBlockForReview").mockImplementation(
      spies.fetchPriorFeedback,
    );
    vi.spyOn(evlog, "logInfo").mockImplementation(spies.logInfo);
    vi.spyOn(evlog, "logWarn").mockImplementation(spies.logWarn);
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
    spies.getAppBotIdentity.mockResolvedValue({ userId: 1, login: "pr-agent[bot]" });
    spies.loadPublishContext.mockResolvedValue({
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
    spies.fetchPrFiles.mockResolvedValue(prFiles);
    spies.lightweight.mockResolvedValue({ handled: false });
    spies.runOrchestratedPrReview.mockResolvedValue(reviewRunResult());
    spies.buildTrustedContext.mockResolvedValue("trusted");
    spies.fetchPriorFeedback.mockResolvedValue(undefined);
    spies.getSummaryCommentGithubId.mockResolvedValue(1);
    mockRepositoryView();
    mockDurableExecution("slash");
  });

  afterEach(() => {
    resetCreatePrSurface();
    vi.restoreAllMocks();
  });

  it("loads publish context in one batched db-read span", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.loadPublishContext).toHaveBeenCalledTimes(1);
    expect(spies.loadPublishContext).toHaveBeenCalledWith(pool, "wi-1", "o/r#1", "review");
  });

  it("continues review when shared rate-limit circuit read fails", async () => {
    spies.getSharedRateLimitCircuit.mockRejectedValueOnce(new Error("db down"));

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.runOrchestratedPrReview).toHaveBeenCalled();
    expect(spies.logWarn).toHaveBeenCalledWith(
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
    expect(spies.openSharedRateLimitCircuitBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lastErrorKind: "primary" }),
    );
  });

  it("passes the resumed thread call count into the review run", async () => {
    spies.loadPublishContext.mockResolvedValueOnce({
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

    expect(spies.runOrchestratedPrReview).toHaveBeenCalledWith(
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
    spies.loadPublishContext.mockResolvedValueOnce({
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

    expect(spies.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ progressCommentIdHint: 4321 }),
    );
  });

  it("skips preflight for slash reviews", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.fetchPrFiles).not.toHaveBeenCalled();
    expect(spies.lightweight).not.toHaveBeenCalled();
    expect(spies.runOrchestratedPrReview).toHaveBeenCalledTimes(1);
    expect(spies.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: "wi-1", resumedPlacements: [] }),
    );
  });

  it("ensures a review check run before the long review", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.ensureReviewCheckRunStarted).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        prSurface: durableSurfaceBundle.surface,
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "head",
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
      }),
    );
    expect(spies.runOrchestratedPrReview).toHaveBeenCalledTimes(1);
  });

  it("passes queue-derived timing and the live review gate to the orchestrator", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    const firstCall = spies.runOrchestratedPrReview.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error("expected orchestrator call");
    }
    const params: OrchestratedReviewRunParams = firstCall[0];
    expect(params.timing.returnByMs - params.timing.modelStopAtMs).toBe(30_000);
    expect(params.timing.remainingTotalMs(params.timing.returnByMs)).toBe(0);
    expect(params.timing.remainingModelMs(params.timing.modelStopAtMs)).toBe(0);
    await expect(params.gate.check()).resolves.toEqual({ kind: "continue" });
    expect(params.prTitle).toBe("");
    expect(params.prBody).toBeNull();
  });

  it("routes a stale-head gate stop through the existing slash reschedule path", async () => {
    durableSurfaceBundle.controls.setHeadSha("new-head");
    spies.runOrchestratedPrReview.mockImplementationOnce(
      async (params: OrchestratedReviewRunParams) => {
        const gate = await params.gate.check();
        expect(gate).toEqual({ kind: "stop", reason: "stale_head" });
        return reviewRunResult({ published: false, publishAttempts: 0, publishSuperseded: true });
      },
    );
    spies.buildStaleReschedule.mockReturnValue({ rescheduled: true });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildStaleReschedule).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ id: "wi-1" }),
    );
  });

  it("routes a stale-head gate stop through reschedule for auto reviews", async () => {
    mockDurableExecution("auto");
    vi.spyOn(durableSurfaceBundle.surface, "getHeadSha").mockResolvedValue("new-head");
    spies.runOrchestratedPrReview.mockImplementationOnce(
      async (params: OrchestratedReviewRunParams) => {
        const gate = await params.gate.check();
        expect(gate).toEqual({ kind: "stop", reason: "stale_head" });
        return reviewRunResult({ published: false, publishAttempts: 0, publishSuperseded: true });
      },
    );
    spies.buildStaleReschedule.mockReturnValue({ rescheduled: true });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildStaleReschedule).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ id: "wi-1", source: "auto" }),
    );
  });

  it("does not create a stale-head replacement when a newer auto review already cancelled the parent", async () => {
    mockDurableExecution("auto");
    vi.spyOn(durableSurfaceBundle.surface, "getHeadSha").mockResolvedValue("new-head");
    // Gate check (false) then post-orchestrator reschedule guard (true).
    spies.shouldSkipWork.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    spies.runOrchestratedPrReview.mockImplementationOnce(
      async (params: OrchestratedReviewRunParams) => {
        const gate = await params.gate.check();
        expect(gate).toEqual({ kind: "stop", reason: "stale_head" });
        return reviewRunResult({ published: false, publishAttempts: 0, publishSuperseded: true });
      },
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildStaleReschedule).not.toHaveBeenCalled();
    expect(reviewCheckRun.completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "cancelled",
        summary: "Review publish was skipped because the work was superseded or cancelled.",
      }),
    );
  });

  it("fails a one-shot stale-head replacement with retry guidance instead of quiet supersede", async () => {
    mockDurableExecution("auto");
    spies.lightweight.mockResolvedValue({ handled: false });
    vi.spyOn(durableSurfaceBundle.surface, "getHeadSha").mockResolvedValue("newer-head");
    vi.spyOn(durableSurfaceBundle.surface, "listChangedFiles").mockResolvedValue({
      ...prFiles,
      headSha: "old-replacement-head",
    });
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      const item = makeReviewWorkItem({
        id: "wi-replacement",
        source: "auto",
        status: "running",
        headSha: "old-replacement-head",
        payload: {
          mode: "review",
          source: "auto",
          staleHeadRescheduled: true,
          staleHeadReplacementWorkItemId: "wi-replacement",
        },
      });
      await expect(
        spec.execute(item, {
          prSurface: durableSurfaceBundle.surface,
          headSha: "old-replacement-head",
          pullRequest: { ...pullRequest, head: { sha: "old-replacement-head" } },
          executionEpoch: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: reviewReschedule.STALE_HEAD_REPLACEMENT_EXHAUSTED });
    });
    spies.runOrchestratedPrReview.mockImplementationOnce(
      async (params: OrchestratedReviewRunParams) => {
        const gate = await params.gate.check();
        expect(gate).toEqual({ kind: "stop", reason: "stale_head" });
        return reviewRunResult({ published: false, publishAttempts: 0, publishSuperseded: true });
      },
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildStaleReschedule).not.toHaveBeenCalled();
  });

  it("preserves superseded gate stops without checking the pull request head", async () => {
    spies.shouldSkipWork.mockResolvedValue(true);
    spies.getWorkItem.mockResolvedValueOnce(
      makeReviewWorkItem({ id: "wi-1", source: "auto", status: "running" }),
    );
    spies.runOrchestratedPrReview.mockImplementationOnce(
      async (params: OrchestratedReviewRunParams) => {
        const gate = await params.gate.check();
        expect(gate).toEqual({ kind: "stop", reason: "superseded" });
        return reviewRunResult({ published: false, publishAttempts: 0, publishSuperseded: true });
      },
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(
      durableSurfaceBundle.controls.events.some(
        (event: FakePrSurfaceEvent) => event.kind === "getHeadSha",
      ),
    ).toBe(false);
    expect(spies.buildStaleReschedule).not.toHaveBeenCalled();
  });

  it("maps slash /cancel into a cancelled gate stop with attribution", async () => {
    spies.shouldSkipWork.mockResolvedValue(true);
    spies.getWorkItem.mockResolvedValueOnce(
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
    spies.runOrchestratedPrReview.mockImplementationOnce(
      async (params: OrchestratedReviewRunParams) => {
        const gate = await params.gate.check();
        expect(gate).toEqual({
          kind: "stop",
          reason: "cancelled",
          attribution: { kind: "user", login: "alice" },
        });
        return reviewRunResult({ published: false, publishAttempts: 0, publishSuperseded: true });
      },
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(
      durableSurfaceBundle.controls.events.some(
        (event: FakePrSurfaceEvent) => event.kind === "getHeadSha",
      ),
    ).toBe(false);
    expect(spies.buildStaleReschedule).not.toHaveBeenCalled();
    expect(reviewCheckRun.completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "cancelled",
      }),
    );
  });

  it("runs auto preflight and lightweight completion before full review", async () => {
    mockDurableExecution("auto");
    const listChangedFiles = mockAutoPrFiles();
    spies.lightweight.mockResolvedValue({ handled: true, published: true, summaryId: 42 });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(listChangedFiles).toHaveBeenCalledTimes(1);
    expect(spies.lightweight).toHaveBeenCalledWith(
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
    expect(spies.withPrRepositoryView).not.toHaveBeenCalled();
    expect(spies.runOrchestratedPrReview).not.toHaveBeenCalled();
    expect(reviewCheckRun.completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "Documentation-only change set.",
      }),
    );
  });

  it("completes an existing check as failure when publish is exhausted", async () => {
    spies.runOrchestratedPrReview.mockResolvedValue(
      reviewRunResult({
        published: false,
        publishAttempts: 3,
        publishSuperseded: false,
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "failure",
        summary: "PR Agent could not publish a structured review.",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
  });

  it("emits review failed with prior provider credit lastFailure", async () => {
    spies.runOrchestratedPrReview.mockResolvedValue(
      reviewRunResult({
        published: false,
        publishAttempts: 2,
        publishSuperseded: false,
        lastFailure: {
          failureDomain: "provider",
          errorKind: "quota",
          errorMessage: "Insufficient credits for model",
          phase: "synthesis",
        },
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.captureEvent).toHaveBeenCalledWith(
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
    expect(spies.logWarn).toHaveBeenCalledWith(
      "review_not_published",
      expect.objectContaining({
        failureDomain: "provider",
        errorKind: "quota",
      }),
    );
  });

  it("emits review published with formula-B timing props when generationMs > 0", async () => {
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics").mockReturnValue(
      metricsSnapshot({
        wallClockMs: 200_000,
        providerOutputTokens: 1500,
        generationMs: 50_000,
        providerOutputTps: 30,
        tokenCoverage: "full_run",
        findingsCount: 2,
        severities: ["high"],
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.captureEvent).toHaveBeenCalledWith(
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
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics").mockReturnValue(
      metricsSnapshot({
        wallClockMs: 12_000,
        providerOutputTokens: 100,
        generationMs: 0,
        tokenCoverage: "orchestrator_only",
        findingsCount: 0,
        severities: [],
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    const publishedCall = spies.captureEvent.mock.calls.find(
      (call) => call[0].event === "review published",
    );
    if (publishedCall === undefined) {
      throw new Error("expected review published event");
    }
    const properties = publishedCall[0].properties;
    expect(properties).toMatchObject({
      wall_clock_ms: 12_000,
      provider_output_tokens: 100,
      token_coverage: "orchestrator_only",
    });
    expect(properties).not.toHaveProperty("generation_ms");
    expect(properties).not.toHaveProperty("provider_output_tps");
  });

  it("emits review failed with timing parity props from snapshot", async () => {
    vi.spyOn(reviewRunMetrics, "snapshotReviewRunMetrics").mockReturnValue(
      metricsSnapshot({
        wallClockMs: 190_000,
        providerOutputTokens: 800,
        generationMs: 40_000,
        providerOutputTps: 20,
        tokenCoverage: "full_run",
        toolCallErrors: 1,
        lastFailure: null,
      }),
    );
    spies.runOrchestratedPrReview.mockResolvedValue(
      reviewRunResult({
        published: false,
        publishAttempts: 2,
        publishSuperseded: false,
        lastFailure: {
          failureDomain: "github",
          errorKind: "rate_limit",
          errorMessage: "API rate limit exceeded",
          phase: "publish",
        },
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.captureEvent).toHaveBeenCalledWith(
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
    spies.runOrchestratedPrReview.mockResolvedValue(
      reviewRunResult({
        published: false,
        publishAttempts: 1,
        publishSuperseded: true,
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "cancelled",
        summary: "Review publish was skipped because the work was superseded or cancelled.",
      }),
    );
  });

  it("completes an existing check as failure from the terminal failure hook", async () => {
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        durableSurfaceBundle.surface,
        new Error("dead"),
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "failure",
        summary: "PR Agent could not complete the review after retries.",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
  });

  it("skips failure notice when a summary sentinel already exists on GitHub", async () => {
    durableSurfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "landed", 4242);
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        durableSurfaceBundle.surface,
        new Error("dead"),
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(
      durableSurfaceBundle.controls.events.filter(
        (event: FakePrSurfaceEvent) => event.kind === "upsertProgressComment",
      ),
    ).toHaveLength(0);
    expect(reviewCheckRun.completeReviewCheckRun).not.toHaveBeenCalled();
  });

  it("does not overwrite a completed summary from the terminal failure hook", async () => {
    spies.hasCompletedPublishStep.mockResolvedValueOnce(true);
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        durableSurfaceBundle.surface,
        new Error("dead"),
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.hasCompletedPublishStep).toHaveBeenCalledWith(
      pool,
      expect.any(String),
      expect.any(String),
      "review",
      "summary_comment",
    );
    expect(
      durableSurfaceBundle.controls.events.filter(
        (event: FakePrSurfaceEvent) => event.kind === "upsertProgressComment",
      ),
    ).toHaveLength(0);
    expect(reviewCheckRun.completeReviewCheckRun).not.toHaveBeenCalled();
  });

  it("completes an existing check as cancelled from the durable cancellation hook", async () => {
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onCancelled?.(
        makeItem("slash"),
        durableSurfaceBundle.surface,
        "skipped_before_claim",
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.cancelReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        headSha: "head",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
    expect(reviewCheckRun.completeReviewCheckRun).not.toHaveBeenCalled();
    expect(spies.runOrchestratedPrReview).not.toHaveBeenCalled();
  });

  it("skips check cancellation from onCancelled when reviewLens is null", async () => {
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec: DurableJobSpec) => {
      await spec.onCancelled?.(
        coreOf(makeAskWorkItem()),
        durableSurfaceBundle.surface,
        "skipped_before_claim",
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.cancelReviewCheckRun).not.toHaveBeenCalled();
  });

  it("still attempts DB-id cancel from onCancelled when headSha is missing", async () => {
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec: DurableJobSpec) => {
      await spec.onCancelled?.(
        { ...makeItem("slash"), headSha: DEFERRED_HEAD_SHA },
        durableSurfaceBundle.surface,
        "skipped_before_claim",
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.cancelReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        headSha: DEFERRED_HEAD_SHA,
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-1",
      }),
    );
  });

  it("passes undefined detailsUrl from onCancelled when summary comment id is null", async () => {
    spies.getSummaryCommentGithubId.mockResolvedValueOnce(null);
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onCancelled?.(
        makeItem("slash"),
        durableSurfaceBundle.surface,
        "skipped_before_claim",
      );
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(reviewCheckRun.cancelReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        detailsUrl: undefined,
      }),
    );
  });

  it("passes auto preflight files into repository preparation", async () => {
    mockDurableExecution("auto");
    const listChangedFiles = mockAutoPrFiles();

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(listChangedFiles).toHaveBeenCalledTimes(1);
    expect(spies.withPrRepositoryView).toHaveBeenCalledTimes(1);
    expect(spies.withPrRepositoryView.mock.calls[0]?.[0]).toMatchObject({
      prFiles,
    });
  });

  it("passes resolved pull payload into repository preparation", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.withPrRepositoryView).toHaveBeenCalledTimes(1);
    expect(spies.withPrRepositoryView.mock.calls[0]?.[0]).toMatchObject({
      pullRequest,
    });
  });

  it("fetches prior feedback while the repository view prepares", async () => {
    let releaseRepositoryView!: () => void;
    const repositoryViewPreparing = new Promise<void>((resolve) => {
      releaseRepositoryView = resolve;
    });
    spies.withPrRepositoryView.mockImplementation(async (_params, run) => {
      await repositoryViewPreparing;
      return run({
        preflight: { preflight: true },
        agentCwd: "/tmp",
        workspace: mockLocalPrWorkspace(),
      });
    });
    spies.fetchPriorFeedback.mockResolvedValue("prior block");

    const review = executeReviewJob(cfg, pool, boss, reviewJob());

    await vi.waitFor(() => expect(spies.fetchPriorFeedback).toHaveBeenCalledTimes(1));
    expect(spies.runOrchestratedPrReview).not.toHaveBeenCalled();

    releaseRepositoryView();
    await review;

    expect(spies.buildTrustedContext).toHaveBeenCalledWith({
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
    spies.getAppBotIdentity.mockRejectedValueOnce(new Error("identity unavailable"));

    await expect(executeReviewJob(cfg, pool, boss, reviewJob())).rejects.toThrow(
      "identity unavailable",
    );

    expect(spies.logWarn).toHaveBeenCalledWith("prior_inline_feedback_fetch_failed", {
      owner: "o",
      repo: "r",
      pr: 1,
      reviewLens: "review",
      message: "identity unavailable",
    });
    expect(spies.fetchPriorFeedback).not.toHaveBeenCalled();
    expect(spies.runOrchestratedPrReview).not.toHaveBeenCalled();
  });

  it("continues the review when prior feedback fetch logs and returns undefined", async () => {
    spies.fetchPriorFeedback.mockImplementationOnce(async (args) => {
      args.onPriorFeedbackError?.(new Error("feedback unavailable"));
      return undefined;
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.logWarn).toHaveBeenCalledWith("prior_inline_feedback_fetch_failed", {
      owner: "o",
      repo: "r",
      pr: 1,
      reviewLens: "review",
      message: "feedback unavailable",
    });
    expect(spies.buildTrustedContext).toHaveBeenCalledWith({
      preflight: { files: [], truncated: false, fileCount: 0, totalChanges: 0 },
      priorInlineFeedback: undefined,
      repoPolicyBlock: undefined,
      agentInstructionFilesBlock: undefined,
      checkoutCoverage: defaultCheckoutCoverage(),
      symbolIndexStatus: { available: false },
      codeIndexStatus: { available: false },
      findingHistoryTrustedBlock: undefined,
    });
    expect(spies.runOrchestratedPrReview).toHaveBeenCalledTimes(1);
  });

  it("rethrows unexpected prior feedback helper rejections", async () => {
    spies.fetchPriorFeedback.mockRejectedValueOnce(new Error("feedback blew up"));

    await expect(executeReviewJob(cfg, pool, boss, reviewJob())).rejects.toThrow(
      "feedback blew up",
    );

    expect(spies.logWarn).toHaveBeenCalledWith("prior_inline_feedback_fetch_failed", {
      owner: "o",
      repo: "r",
      pr: 1,
      reviewLens: "review",
      message: "feedback blew up",
    });
    expect(spies.runOrchestratedPrReview).not.toHaveBeenCalled();
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
    spies.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        preflight,
        agentCwd: policyDir,
        workspace: mockLocalPrWorkspace(policyDir),
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildTrustedContext).toHaveBeenCalledWith({
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
    spies.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        preflight,
        agentCwd: policyDir,
        workspace: mockLocalPrWorkspace(policyDir),
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildTrustedContext).toHaveBeenCalledWith({
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
    spies.withPrRepositoryView.mockImplementation(async (_params, run) =>
      run({
        preflight,
        agentCwd: checkout,
        workspace: mockLocalPrWorkspace(checkout),
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.buildTrustedContext).toHaveBeenCalledWith({
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

    expect(spies.runOrchestratedPrReview).toHaveBeenCalledWith(
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
        prSurface: durableSurfaceBundle.surface,
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
        pullRequest: prWithDescriptionOnly,
      });
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.runOrchestratedPrReview).toHaveBeenCalledWith(
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
        prSurface: durableSurfaceBundle.surface,
        headSha: "head",
        executionEpoch: 1,
        signal: new AbortController().signal,
        pullRequest: prWithDescription,
      });
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(spies.runOrchestratedPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ hasDescriptionReviewMap: true }),
    );
  });
});
