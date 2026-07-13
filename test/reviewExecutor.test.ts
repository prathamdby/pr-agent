import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { AgentWorkItem, ReviewJobData } from "../src/agentWork/types.js";
import { DESCRIPTION_AGENT_HEADER } from "../src/settings/index.js";
import { makeTestConfig } from "./helpers/config.js";
import { mockLocalPrWorkspace } from "./helpers/mockWorkspace.js";

const mocks = vi.hoisted(() => ({
  loadPublishContext: vi.fn(),
  fetchPrFiles: vi.fn(),
  lightweight: vi.fn(),
  runFullPrReview: vi.fn(),
  withPrRepositoryView: vi.fn(),
  buildStaleReschedule: vi.fn(),
  buildTrustedContext: vi.fn(),
  fetchPriorFeedback: vi.fn(),
  getAppBotIdentity: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  getSummaryCommentGithubId: vi.fn(async (): Promise<number | null> => null),
  recordPublishStep: vi.fn(),
  shouldSkipWork: vi.fn(async () => false),
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
}));

vi.mock("../src/agentWork/repository.js", () => ({
  loadReviewExecutorPublishContext: mocks.loadPublishContext,
  recordPublishStep: mocks.recordPublishStep,
  shouldSkipWork: mocks.shouldSkipWork,
  getSummaryCommentGithubId: mocks.getSummaryCommentGithubId,
}));

vi.mock("../src/agentWork/reviewCheckRun.js", () => ({
  ensureReviewCheckRunStarted: mocks.ensureCheckRunStarted,
  completeReviewCheckRun: mocks.completeCheckRun,
  reviewCheckDetailsUrl: mocks.reviewCheckDetailsUrl,
}));

vi.mock("../src/review/run/reviewRun.js", () => ({
  runFullPrReview: mocks.runFullPrReview,
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
  getPullRequestHead: vi.fn(async () => ({ headSha: "head" })),
  getPullRequestHeadSha: vi.fn(async () => "head"),
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
      workspace: mockLocalPrWorkspace(),
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
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: "",
    output: {},
  };
}

function mockDurableExecution(source: "auto" | "slash" = "slash"): void {
  vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
    const item = makeItem(source);
    await spec.execute(item, {
      installation: {
        token: "tok",
        expiresAtTs: Date.now() + 60_000,
        ttlMs: 60_000,
      },
      headSha: "head",
      pullRequest: source === "slash" ? pullRequest : undefined,
    });
  });
}

describe("executeReviewJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(listPullRequestFiles, "fetchPullRequestFiles").mockImplementation(mocks.fetchPrFiles);
    vi.spyOn(reviewLightweightCompletion, "tryLightweightAutoReviewCompletion").mockImplementation(
      mocks.lightweight,
    );
    vi.spyOn(prWorkspace, "withPrRepositoryView").mockImplementation(mocks.withPrRepositoryView);
    vi.spyOn(reviewReschedule, "buildStaleSlashReviewRescheduleResult").mockImplementation(
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
        inlinePublished: false,
        summaryPublished: false,
        inlineReviewId: null,
      },
      shouldLinkToSummary: false,
      storedInlineFingerprints: [],
      summaryCommentGithubId: null,
    });
    mocks.fetchPrFiles.mockResolvedValue(prFiles);
    mocks.lightweight.mockResolvedValue({ handled: false });
    mocks.runFullPrReview.mockResolvedValue({
      published: true,
      publishAttempts: 1,
      publishSuperseded: false,
    });
    mocks.buildTrustedContext.mockReturnValue({
      trustedContext: "trusted",
      sizeBudget: {
        tier: "small",
        truncated: false,
        fileCount: 1,
        totalChanges: 1,
        selectedReviewerIds: [
          "correctness",
          "security",
          "tests",
          "maintainability",
          "project-standards",
          "reliability",
          "api-contracts",
          "adversarial",
        ],
        omittedReviewerIds: [],
      },
    });
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

  it("skips preflight for slash reviews", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.fetchPrFiles).not.toHaveBeenCalled();
    expect(mocks.lightweight).not.toHaveBeenCalled();
    expect(mocks.runFullPrReview).toHaveBeenCalledTimes(1);
  });

  it("ensures a review check run before the long review", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.ensureCheckRunStarted).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        cfg,
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
    expect(mocks.runFullPrReview).toHaveBeenCalledTimes(1);
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
    expect(mocks.runFullPrReview).not.toHaveBeenCalled();
    expect(mocks.completeCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "Documentation-only change set.",
      }),
    );
  });

  it("completes an existing check as failure when publish is exhausted", async () => {
    mocks.runFullPrReview.mockResolvedValue({
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

  it("completes an existing check as cancelled when publish is superseded", async () => {
    mocks.runFullPrReview.mockResolvedValue({
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
    vi.spyOn(durableJob, "runDurableWorkItem").mockImplementation(async (spec) => {
      await spec.onTerminalFailure?.(
        makeItem("slash"),
        {
          token: "tok",
          expiresAtTs: Date.now() + 60_000,
          ttlMs: 60_000,
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
    expect(mocks.runFullPrReview).not.toHaveBeenCalled();
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
    expect(mocks.runFullPrReview).not.toHaveBeenCalled();

    releaseRepositoryView();
    await review;

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight: { preflight: true },
      priorInlineFeedback: "prior block",
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
    expect(mocks.runFullPrReview).not.toHaveBeenCalled();
  });

  it("appends rendered repo policy to trusted context when policy file is present", async () => {
    const policyDir = await mkdtemp(join(tmpdir(), "repo-policy-exec-"));
    await writeFile(
      join(policyDir, ".pr-agent.yml"),
      "version: 1\ntone: Be terse\nseverityFloor: 2\n",
      "utf8",
    );
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
        workspace: undefined,
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight,
      priorInlineFeedback: undefined,
      repoPolicyBlock: expect.stringContaining("Tone: Be terse"),
    });
    expect(mocks.runFullPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ severityFloor: 2 }),
    );
  });

  it("leaves trusted context unchanged when repo policy file is absent", async () => {
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
        workspace: undefined,
      }),
    );

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.buildTrustedContext).toHaveBeenCalledWith({
      preflight,
      priorInlineFeedback: undefined,
      repoPolicyBlock: undefined,
    });
    expect(mocks.runFullPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ severityFloor: undefined }),
    );
  });

  it("threads hasDescriptionAgentBlock false when PR body lacks the description header", async () => {
    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runFullPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ hasDescriptionAgentBlock: false }),
    );
  });

  it("threads hasDescriptionAgentBlock true when PR body contains the description header", async () => {
    const prWithDescription = {
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
        pullRequest: prWithDescription,
      });
    });

    await executeReviewJob(cfg, pool, boss, reviewJob());

    expect(mocks.runFullPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ hasDescriptionAgentBlock: true }),
    );
  });
});
