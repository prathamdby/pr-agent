import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { executeAckJob } from "../src/agentWork/executors/ackExecutor.js";
import type { AckJobData } from "../src/agentWork/types.js";
import { GITHUB_REACTION_EYES, GITHUB_REACTION_PLUS_ONE } from "../src/settings/index.js";

vi.mock("../src/agentWork/durableJob.js", () => ({
  mintInstallationToken: vi.fn(async () => ({
    token: "tok",
    expiresAtTs: Date.now() + 3_600_000,
    ttlMs: 3_600_000,
  })),
}));

vi.mock("../src/agentWork/githubPrSurface.js", () => ({
  getAppBotIdentity: vi.fn(async () => ({ userId: 999, login: "pr-agent[bot]" })),
  getPullRequestHeadSha: vi.fn(),
  postAckReply: vi.fn(),
  reactOnAckTargets: vi.fn(),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  resolveVerifiedSummaryCommentRef: vi.fn(),
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 77, updated: true })),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getSummaryCommentGithubId: vi.fn(async () => null),
  getProgressCommentOwner: vi.fn(async () => null),
  getWorkItemCore: vi.fn(async () => ({
    id: "wi-1",
    status: "running",
    type: "review",
  })),
  recordPublishStep: vi.fn(),
  claimSummaryCommentCreation: vi.fn(async () => true),
}));

vi.mock("../src/review/publish/publishReview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/review/publish/publishReview.js")>();
  return {
    ...actual,
    upsertSummaryCommentWithCreationClaim: vi.fn(async () => ({ id: 42, updated: false })),
  };
});

vi.mock("../src/agentWork/reviewCheckRun.js", () => ({
  ensureReviewCheckRunStarted: vi.fn(),
}));

import { postAckReply, reactOnAckTargets } from "../src/agentWork/githubPrSurface.js";
import {
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";
import { upsertSummaryCommentWithCreationClaim } from "../src/review/publish/publishReview.js";
import {
  getProgressCommentOwner,
  getSummaryCommentGithubId,
  getWorkItemCore,
  recordPublishStep,
} from "../src/agentWork/repository.js";
import { ensureReviewCheckRunStarted } from "../src/agentWork/reviewCheckRun.js";

const cfg = {} as Config;
const pool = {} as Pool;

function ackData(): AckJobData {
  return {
    kind: "ack",
    installationId: 42,
    owner: "o",
    repo: "r",
    prNumber: 1,
    targets: [
      { kind: "pr", prNumber: 1 },
      { kind: "issueComment", commentId: 10 },
      { kind: "reviewComment", commentId: 20 },
    ],
  };
}

describe("executeAckJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts eyes on every ack target", async () => {
    await expect(executeAckJob(cfg, pool, ackData())).resolves.toBeUndefined();

    expect(reactOnAckTargets).toHaveBeenCalledTimes(1);
    expect(reactOnAckTargets).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      ackData().targets,
      GITHUB_REACTION_EYES,
      999,
      expect.any(Number),
    );
  });

  it("adds plus-one after ack-only replies with no durable work item", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "help" },
    });

    expect(postAckReply).toHaveBeenCalled();
    expect(reactOnAckTargets).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reactOnAckTargets).mock.calls[1]?.[4]).toBe(GITHUB_REACTION_PLUS_ONE);
    expect(vi.mocked(reactOnAckTargets).mock.calls[1]?.[5]).toBe(999);
  });

  it("does not plus-one when a durable work item will own the outcome reaction", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      reply: { target: { kind: "prConversation", prNumber: 1 }, body: "hint" },
    });

    expect(reactOnAckTargets).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reactOnAckTargets).mock.calls[0]?.[4]).toBe(GITHUB_REACTION_EYES);
  });

  it("uses coordinated summary upsert for progress with work item id", async () => {
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-1",
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        progressRevision: 0,
        body: expect.stringMatching(/Review queued/),
      }),
    );
    const queuedBody = vi.mocked(upsertSummaryCommentWithCreationClaim).mock.calls[0]?.[0]?.body;
    expect(queuedBody).not.toMatch(/Recon/);
    expect(queuedBody).not.toMatch(/Correctness/);
    const body = vi.mocked(upsertSummaryCommentWithCreationClaim).mock.calls[0]?.[0]?.body;
    expect(body).toContain("<!-- pr-agent:review-meta headSha=invalid lens=review stale=false -->");
    expect(recordPublishStep).not.toHaveBeenCalled();
    expect(ensureReviewCheckRunStarted).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        reviewLens: "review",
      }),
    );
  });

  it("uses revision coordination when progress has no work item id", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 55,
      url: "https://example.com/55",
      source: "hint",
    });

    await executeAckJob(cfg, pool, {
      ...ackData(),
      progress: { lens: "review", headSha: "sha", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        workItemId: undefined,
        resourceKey: "o/r#1",
        reviewLens: "review",
        progressRevision: 0,
      }),
    );
    expect(getSummaryCommentGithubId).not.toHaveBeenCalled();
    expect(resolveVerifiedSummaryCommentRef).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
  });

  it("no-ops progress when the work item is superseded", async () => {
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-stale",
      status: "superseded",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-stale",
      progress: { lens: "review", headSha: "sha-a", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).not.toHaveBeenCalled();
    expect(ensureReviewCheckRunStarted).not.toHaveBeenCalled();
  });

  it("executes acknowledgements in reverse order without letting A overwrite B", async () => {
    vi.mocked(getWorkItemCore).mockImplementation(async (_pool, id: string) => {
      if (id === "wi-b") {
        return { id: "wi-b", status: "running", type: "review" } as Awaited<
          ReturnType<typeof getWorkItemCore>
        >;
      }
      return { id: "wi-a", status: "superseded", type: "review" } as Awaited<
        ReturnType<typeof getWorkItemCore>
      >;
    });
    vi.mocked(getProgressCommentOwner)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ workItemId: "wi-b", generation: 1 });

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-b",
      progress: { lens: "review", headSha: "sha-b", source: "auto" },
    });
    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-a",
      progress: { lens: "review", headSha: "sha-a", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledTimes(1);
    expect(upsertSummaryCommentWithCreationClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "wi-b",
        progressRevision: 0,
      }),
    );
  });

  it("skips progress when another work item already owns the comment", async () => {
    vi.mocked(getWorkItemCore).mockResolvedValueOnce({
      id: "wi-a",
      status: "running",
      type: "review",
    } as Awaited<ReturnType<typeof getWorkItemCore>>);
    vi.mocked(getProgressCommentOwner).mockResolvedValueOnce({
      workItemId: "wi-b",
      generation: 1,
    });

    await executeAckJob(cfg, pool, {
      ...ackData(),
      workItemId: "wi-a",
      progress: { lens: "review", headSha: "sha-a", source: "auto" },
    });

    expect(upsertSummaryCommentWithCreationClaim).not.toHaveBeenCalled();
  });
});
