import { vi } from "vitest";
import type { JobWithMetadata } from "pg-boss";
import type { AgentWorkItem, AgentWorkItemCore } from "../../src/agentWork/types.js";
import {
  createFakePrSurface,
  type FakePrSurfaceControls,
  type PrReviewComment,
} from "../../src/github/prSurface.js";
import { VERIFICATION_STUB_MARKER } from "../../src/settings/index.js";
import { renderReviewPointerLensMarker } from "../../src/review/run/reviewRender.js";
import type { BotFindingThread } from "../../src/review/run/reviewPriorFeedback.js";
import * as repo from "../../src/agentWork/workItemStateRepository.js";
import type { WorkClaim } from "../../src/agentWork/workItemStateRepository.js";

let durableSurfaceBundle = createFakePrSurface(
  { owner: "o", repo: "r", prNumber: 1 },
  { headSha: "head", credentialToken: "tok" },
);

export function resetDurablePrSurface(
  params: { owner?: string; repo?: string; prNumber?: number; headSha?: string } = {},
) {
  seededComments = [];
  durableSurfaceBundle = createFakePrSurface(
    {
      owner: params.owner ?? "o",
      repo: params.repo ?? "r",
      prNumber: params.prNumber ?? 1,
    },
    { headSha: params.headSha ?? "head", credentialToken: "tok" },
  );
  return durableSurfaceBundle;
}

export function durablePrSurfaceControls(): FakePrSurfaceControls {
  return durableSurfaceBundle.controls;
}

const SEEDED_BOT_USER_ID = 999;
let seededComments: PrReviewComment[] = [];

function seedComment(
  comment: Partial<PrReviewComment> & Pick<PrReviewComment, "id" | "body">,
): PrReviewComment {
  return {
    inReplyToId: null,
    pullRequestReviewId: null,
    userId: null,
    authorLogin: "someone",
    authorAssociation: null,
    path: null,
    line: null,
    originalLine: null,
    htmlUrl: "",
    ...comment,
  };
}

/** Seed raw GitHub listings so the production thread assembly yields these bot findings. */
export function seedBotFindingThreads(
  threads: readonly BotFindingThread[],
  controls: FakePrSurfaceControls = durablePrSurfaceControls(),
): void {
  seededComments = [];
  controls.setPullRequestReviews(
    threads.map((thread) => ({
      id: 10_000 + thread.rootCommentId,
      userId: SEEDED_BOT_USER_ID,
      authorLogin: "pr-agent[bot]",
      body: renderReviewPointerLensMarker(thread.lens),
      commitId: null,
      htmlUrl: "",
    })),
  );
  let nextReplyId = 100_000;
  for (const thread of threads) {
    const titleMatch = /^(P[0-3]) · (.*)$/.exec(thread.titleSnippet);
    seededComments.push(
      seedComment({
        id: thread.rootCommentId,
        userId: SEEDED_BOT_USER_ID,
        authorLogin: "pr-agent[bot]",
        pullRequestReviewId: 10_000 + thread.rootCommentId,
        path: thread.path,
        line: thread.line,
        originalLine: thread.line,
        htmlUrl: thread.threadUrl,
        body: titleMatch ? `**${titleMatch[1]}** · **${titleMatch[2]}**` : thread.titleSnippet,
      }),
    );
    for (const reply of thread.humanReplies) {
      seededComments.push(
        seedComment({
          id: nextReplyId++,
          inReplyToId: thread.rootCommentId,
          userId: 7,
          body: reply,
        }),
      );
    }
    if (thread.hasTriageReply === true) {
      seededComments.push(
        seedComment({
          id: nextReplyId++,
          inReplyToId: thread.rootCommentId,
          userId: SEEDED_BOT_USER_ID,
          body: "**Triage**: handled",
        }),
      );
    }
    if (thread.verificationStubCommentId != null) {
      seededComments.push(
        seedComment({
          id: thread.verificationStubCommentId,
          inReplyToId: thread.rootCommentId,
          userId: SEEDED_BOT_USER_ID,
          body: `${VERIFICATION_STUB_MARKER}\n**Verification**: stub`,
        }),
      );
    }
  }
  controls.setReviewComments(seededComments);
}

/** Add reply-graph nodes for thread-root resolution without disturbing seeded findings. */
export function seedReviewCommentGraph(
  nodes: readonly { readonly id: number; readonly inReplyToId: number | null }[],
): void {
  for (const node of nodes) {
    if (seededComments.some((comment) => comment.id === node.id)) continue;
    seededComments.push(seedComment({ id: node.id, inReplyToId: node.inReplyToId, body: "" }));
  }
  durablePrSurfaceControls().setReviewComments(seededComments);
}

export function fakeDurablePrSurface(
  params: { owner?: string; repo?: string; prNumber?: number } = {},
) {
  if (
    params.owner != null &&
    (params.owner !== "o" || params.repo !== "r" || params.prNumber !== 1)
  ) {
    return createFakePrSurface({
      owner: params.owner ?? "o",
      repo: params.repo ?? "r",
      prNumber: params.prNumber ?? 1,
    }).surface;
  }
  return durableSurfaceBundle.surface;
}

export function coreOf(item: AgentWorkItem): AgentWorkItemCore {
  switch (item.type) {
    case "review": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "ask": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "description": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "triage": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    case "verification": {
      const { payload: _payload, ...core } = item;
      return core;
    }
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

export function mockWorkClaim(overrides: Partial<WorkClaim> = {}): WorkClaim {
  return {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:05.000Z"),
    attemptCount: 1,
    resumed: false,
    ...overrides,
  };
}

export function setupDefaultDurableRepositoryMocks(): void {
  vi.mocked(repo.shouldSkipWork).mockResolvedValue(false);
  vi.mocked(repo.claimWorkForExecution).mockResolvedValue(mockWorkClaim());
  vi.mocked(repo.updateRunningWorkHeadSha).mockResolvedValue(true);
  vi.mocked(repo.markWorkCompleted).mockResolvedValue(true);
  vi.mocked(repo.markWorkFailed).mockResolvedValue(true);
  vi.mocked(repo.markWorkRetrying).mockResolvedValue(true);
  vi.mocked(repo.markWorkCancelled).mockResolvedValue(undefined);
  vi.mocked(repo.markWorkPublishDegraded).mockResolvedValue(undefined);
}

export function makeDurableJobMetadata(
  workItemId = "wi-1",
  retryCount = 0,
  retryLimit = 3,
): JobWithMetadata<{ workItemId: string }> {
  const now = new Date();
  return {
    id: "job-1",
    name: "agent-work",
    data: { workItemId },
    expireInSeconds: 3600,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: "active",
    retryLimit,
    retryCount,
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
    sourceOutput: null,
    sourceRootId: null,
  };
}
