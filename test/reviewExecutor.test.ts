import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { AgentWorkItem, ReviewJobData } from "../src/agentWork/types.js";
import { makeTestConfig } from "./helpers/config.js";

const mocks = vi.hoisted(() => ({
  loadPublishContext: vi.fn(),
  fetchPreflight: vi.fn(),
  lightweight: vi.fn(),
  runFullPrReview: vi.fn(),
  withPrRepositoryView: vi.fn(),
  runDurableWorkItem: vi.fn(),
  buildStaleReschedule: vi.fn(),
}));

vi.mock("../src/agentWork/durableJob.js", () => ({
  makeInstallationTokenRefresher: vi.fn(() => async () => ({
    token: "t",
    expiresAtTs: Date.now() + 60_000,
  })),
  resolveWorkItemHeadSha: vi.fn(async () => "head"),
  runDurableWorkItem: mocks.runDurableWorkItem,
}));

vi.mock("../src/agentWork/repository.js", () => ({
  loadReviewExecutorPublishContext: mocks.loadPublishContext,
  recordPublishStep: vi.fn(),
  shouldSkipWork: vi.fn(),
}));

vi.mock("../src/review/reviewPreflightFiles.js", () => ({
  fetchReviewPreflightMetadata: mocks.fetchPreflight,
}));

vi.mock("../src/agentWork/reviewLightweightCompletion.js", () => ({
  tryLightweightAutoReviewCompletion: mocks.lightweight,
}));

vi.mock("../src/review/reviewRun.js", () => ({
  runFullPrReview: mocks.runFullPrReview,
}));

vi.mock("../src/agentWork/reviewReschedule.js", () => ({
  buildStaleSlashReviewRescheduleResult: mocks.buildStaleReschedule,
}));

vi.mock("../src/prWorkspace/index.js", () => ({
  withPrRepositoryView: mocks.withPrRepositoryView,
}));

vi.mock("../src/review/reviewTrustedContext.js", () => ({
  buildTrustedReviewContextForReview: vi.fn(async () => "trusted"),
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getAppBotIdentity: vi.fn(async () => ({ userId: 1 })),
  getPullRequestHeadSha: vi.fn(async () => "head"),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  upsertReviewSummaryComment: vi.fn(),
}));

vi.mock("../src/review/reviewRunMetrics.js", () => ({
  initReviewRunMetrics: vi.fn(),
  logReviewRunCompleted: vi.fn(),
  recordReviewPhaseSpan: vi.fn(async (_phase: string, run: () => Promise<unknown>) => run()),
  setReviewRunMetricFields: vi.fn(),
}));

import { executeReviewJob } from "../src/agentWork/executors/reviewExecutor.js";

const cfg = makeTestConfig({ piModel: "test" });
const pool = {} as Pool;
const boss = {} as PgBoss;

function makeItem(source: "auto" | "slash"): AgentWorkItem {
  return {
    id: "wi-1",
    webhookEventId: "ev-1",
    type: "review",
    source,
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "head",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 0,
    payload: { mode: "review", source },
    cancelRequestedAt: null,
  };
}

function mockRepositoryView() {
  mocks.withPrRepositoryView.mockImplementation(async (_params, run) =>
    run({
      preflight: { preflight: true },
      agentCwd: "/tmp",
      workspace: undefined,
    }),
  );
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
    deadLetter: "",
    output: {},
  };
}

describe("executeReviewJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPublishContext.mockResolvedValue({
      publishState: {
        inlinePublished: false,
        summaryPublished: false,
        inlineReviewId: null,
      },
      shouldLinkToSummary: false,
      storedInlineFingerprints: [],
      summaryCommentGithubId: null,
    });
    mocks.fetchPreflight.mockResolvedValue({ fileCount: 1 });
    mocks.lightweight.mockResolvedValue({ handled: false });
    mocks.runFullPrReview.mockResolvedValue({
      published: true,
      publishAttempts: 1,
      publishSuperseded: false,
    });
    mockRepositoryView();
    mocks.runDurableWorkItem.mockImplementation(async (spec) => {
      const item = makeItem("slash");
      await spec.execute(item, {
        installation: {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
        },
        headSha: "head",
      });
    });
  });

  it("loads publish context in one batched db-read span", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.loadPublishContext).toHaveBeenCalledTimes(1);
    expect(mocks.loadPublishContext).toHaveBeenCalledWith(pool, "wi-1", "o/r#1", "review");
  });

  it("skips preflight for slash reviews", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.fetchPreflight).not.toHaveBeenCalled();
    expect(mocks.lightweight).not.toHaveBeenCalled();
    expect(mocks.runFullPrReview).toHaveBeenCalledTimes(1);
  });

  it("runs auto preflight and lightweight completion before full review", async () => {
    mocks.runDurableWorkItem.mockImplementation(async (spec) => {
      const item = makeItem("auto");
      await spec.execute(item, {
        installation: {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
        },
        headSha: "head",
      });
    });
    mocks.lightweight.mockResolvedValue({ handled: true, published: true });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.fetchPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.lightweight).toHaveBeenCalledTimes(1);
    expect(mocks.withPrRepositoryView).not.toHaveBeenCalled();
    expect(mocks.runFullPrReview).not.toHaveBeenCalled();
  });
});
