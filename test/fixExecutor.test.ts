import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { Config } from "../src/config.js";
import type { FixJobData, FixWorkPayload } from "../src/agentWork/types.js";
import type { AutoFixTarget } from "../src/autoFix/types.js";
import { FIX_PUSH_STALE } from "../src/settings/index.js";

const ORIGINAL_HEAD = "a".repeat(40);
const FIX_HEAD = "b".repeat(40);
const MOVED_HEAD = "c".repeat(40);

const mocks = vi.hoisted(() => ({
  runDurableWorkItem: vi.fn(),
  findActiveFixConflict: vi.fn(),
  getRepositoryPermission: vi.fn(),
  getPullRequestBranchContext: vi.fn(),
  getBranchHeadSha: vi.fn(),
  createOrReuseFallbackPullRequest: vi.fn(),
  findAutoFixTargetByInlineComment: vi.fn(),
  findLatestAutoFixTargetsByLens: vi.fn(),
  fetchPullRequestFiles: vi.fn(),
  getAppBotIdentity: vi.fn(),
  postSlashReply: vi.fn(),
  prepareAutoFixWorkspace: vi.fn(),
  runAutoFixTargetGroup: vi.fn(),
  recordFixPublishCheckpoint: vi.fn(),
}));

vi.mock("../src/agentWork/durableJob.js", () => ({
  resolveWorkItemHeadSha: vi.fn(async () => ORIGINAL_HEAD),
  runDurableWorkItem: mocks.runDurableWorkItem,
}));

vi.mock("../src/agentWork/intake/workItemRepository.js", () => ({
  findActiveFixConflict: mocks.findActiveFixConflict,
}));

vi.mock("../src/autoFix/github.js", () => ({
  getPullRequestBranchContext: mocks.getPullRequestBranchContext,
  getRepositoryPermission: mocks.getRepositoryPermission,
  permissionCanAutoFix: (permission: string) =>
    permission === "write" || permission === "maintain" || permission === "admin",
  getBranchHeadSha: mocks.getBranchHeadSha,
  createOrReuseFallbackPullRequest: mocks.createOrReuseFallbackPullRequest,
}));

vi.mock("../src/autoFix/repository.js", () => ({
  findAutoFixTargetByInlineComment: mocks.findAutoFixTargetByInlineComment,
  findLatestAutoFixTargetsByLens: mocks.findLatestAutoFixTargetsByLens,
}));

vi.mock("../src/github/listPullRequestFiles.js", () => ({
  fetchPullRequestFiles: mocks.fetchPullRequestFiles,
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getAppBotIdentity: mocks.getAppBotIdentity,
  postSlashReply: mocks.postSlashReply,
}));

vi.mock("../src/autoFix/workspace.js", () => ({
  prepareAutoFixWorkspace: mocks.prepareAutoFixWorkspace,
}));

vi.mock("../src/autoFix/run.js", () => ({
  runAutoFixTargetGroup: mocks.runAutoFixTargetGroup,
}));

vi.mock("../src/agentWork/repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agentWork/repository.js")>()),
  recordFixPublishCheckpoint: mocks.recordFixPublishCheckpoint,
}));

import { executeFixJob } from "../src/agentWork/executors/fixExecutor.js";

const cfg = {
  maxPrFilesListed: 100,
  maxPrFilesPatchBytes: 100_000,
} as Config;
const pool = {} as Pool;
const boss = {} as PgBoss;
const job = {
  id: "job-1",
  data: { kind: "fix", workItemId: "work-1" },
  retryCount: 0,
  retryLimit: 3,
} as JobWithMetadata<FixJobData>;

const basePayload: FixWorkPayload = {
  selector: { kind: "inline", inlineReviewCommentId: 99 },
  replyTarget: { kind: "prConversation", prNumber: 7 },
  commenterId: 123,
  commenterLogin: "dev",
  commandCommentId: 456,
};

function branchContext(headSha: string) {
  return {
    headSha,
    headRef: "feature",
    headRepoFullName: "acme/app",
    baseRef: "main",
    baseRepoFullName: "acme/app",
    baseOwner: "acme",
    baseRepo: "app",
  };
}

function target(overrides: Partial<AutoFixTarget> = {}): AutoFixTarget {
  return {
    id: "target-1",
    bundleId: "bundle-1",
    workItemId: "review-1",
    resourceKey: "acme/app#7",
    reviewLens: "review",
    headSha: ORIGINAL_HEAD,
    fingerprint: "fp",
    severity: "P1",
    filePath: "src/app.ts",
    startLine: 1,
    endLine: 1,
    title: "Bug",
    detail: "detail",
    fixPrompt: "fix",
    placementKind: "inline",
    inlineReviewCommentId: 99,
    ...overrides,
  };
}

function workspace() {
  return {
    reset: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    commitAll: vi.fn(async () => ({
      sha: FIX_HEAD,
      message: "Auto-fix P1: Bug",
      changedPaths: ["src/app.ts"],
    })),
    pushHeadToBranch: vi.fn(async () => undefined),
  };
}

async function runExecutor(payload: FixWorkPayload, headSha = ORIGINAL_HEAD): Promise<void> {
  mocks.runDurableWorkItem.mockImplementation(async (spec) => {
    await spec.execute(
      {
        id: "work-1",
        webhookEventId: "event-1",
        type: "fix",
        source: "slash",
        status: "running",
        owner: "acme",
        repo: "app",
        prNumber: 7,
        installationId: 42,
        headSha,
        reviewLens: null,
        resourceKey: "acme/app#7",
        attemptCount: 1,
        payload,
        cancelRequestedAt: null,
      },
      {
        installation: { token: "tok", expiresAtTs: Date.now() + 60_000, ttlMs: 60_000 },
        headSha,
      },
    );
  });

  await executeFixJob(cfg, pool, boss, job);
}

describe("executeFixJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findActiveFixConflict.mockResolvedValue({ kind: "none" });
    mocks.getRepositoryPermission.mockResolvedValue("write");
    mocks.findAutoFixTargetByInlineComment.mockResolvedValue(target());
    mocks.findLatestAutoFixTargetsByLens.mockResolvedValue([]);
    mocks.fetchPullRequestFiles.mockResolvedValue({ headSha: ORIGINAL_HEAD, files: [] });
    mocks.getAppBotIdentity.mockResolvedValue({ userId: 1, login: "pr-agent[bot]" });
    mocks.runAutoFixTargetGroup.mockResolvedValue({ outcome: "fixed", summary: "fixed" });
    mocks.getBranchHeadSha.mockResolvedValue(null);
    mocks.createOrReuseFallbackPullRequest.mockResolvedValue({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      reused: false,
    });
  });

  it("rechecks the PR head before falling back after a direct push failure", async () => {
    const ws = workspace();
    ws.pushHeadToBranch.mockRejectedValueOnce(new Error("push denied"));
    mocks.prepareAutoFixWorkspace.mockResolvedValue(ws);
    mocks.getPullRequestBranchContext
      .mockResolvedValueOnce(branchContext(ORIGINAL_HEAD))
      .mockResolvedValueOnce(branchContext(ORIGINAL_HEAD))
      .mockResolvedValueOnce(branchContext(MOVED_HEAD));

    await runExecutor(basePayload);

    expect(ws.pushHeadToBranch).toHaveBeenCalledTimes(1);
    expect(mocks.getBranchHeadSha).not.toHaveBeenCalled();
    expect(mocks.createOrReuseFallbackPullRequest).not.toHaveBeenCalled();
    expect(mocks.postSlashReply).toHaveBeenCalledWith(
      "tok",
      "acme",
      "app",
      basePayload.replyTarget,
      FIX_PUSH_STALE,
    );
  });

  it("replies from a prior publish checkpoint without rerunning auto-fix", async () => {
    const replyBody = "Auto-fix applied commits:\n- bbbbbbbbbbbb Auto-fix P1: Bug";
    const payload: FixWorkPayload = {
      ...basePayload,
      publishCheckpoint: { kind: "direct", headSha: FIX_HEAD, replyBody },
    };
    mocks.getPullRequestBranchContext.mockResolvedValueOnce(branchContext(FIX_HEAD));

    await runExecutor(payload, FIX_HEAD);

    expect(mocks.findAutoFixTargetByInlineComment).not.toHaveBeenCalled();
    expect(mocks.prepareAutoFixWorkspace).not.toHaveBeenCalled();
    expect(mocks.runAutoFixTargetGroup).not.toHaveBeenCalled();
    expect(mocks.postSlashReply).toHaveBeenCalledWith(
      "tok",
      "acme",
      "app",
      basePayload.replyTarget,
      replyBody,
    );
  });

  it("records a publish checkpoint after a successful direct push", async () => {
    const ws = workspace();
    mocks.prepareAutoFixWorkspace.mockResolvedValue(ws);
    mocks.getPullRequestBranchContext
      .mockResolvedValueOnce(branchContext(ORIGINAL_HEAD))
      .mockResolvedValueOnce(branchContext(ORIGINAL_HEAD));

    await runExecutor(basePayload);

    expect(mocks.recordFixPublishCheckpoint).toHaveBeenCalledWith(pool, {
      workItemId: "work-1",
      checkpoint: expect.objectContaining({
        kind: "direct",
        headSha: FIX_HEAD,
        replyBody: expect.stringContaining("Auto-fix applied commits:"),
      }),
    });
    expect(ws.pushHeadToBranch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordFixPublishCheckpoint.mock.invocationCallOrder[0],
    );
    expect(mocks.recordFixPublishCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.postSlashReply.mock.invocationCallOrder[0],
    );
  });
});
