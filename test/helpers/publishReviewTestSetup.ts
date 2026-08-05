import { vi } from "vitest";
import type { ReviewPayload } from "../../src/review/reviewSchema.js";
import type * as reviewPublish from "../../src/github/reviewPublish.js";
import { makeReviewPayload } from "./reviewPayloadFactory.js";
import { makeTestConfig } from "./config.js";

export const publishReviewTestPayload: ReviewPayload = makeReviewPayload({
  prCharacter: "Test PR.",
  findings: [
    {
      severity: "P1",
      file: "src/x.ts",
      startLine: 4,
      endLine: 4,
      title: "Bug",
      detail: "Bad logic.",
      fixPrompt: "Fix src/x.ts line 4.",
    },
  ],
});

export const publishReviewTestBaseParams = {
  token: "t",
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "sha",
  hasDescriptionReviewMap: false,
  progressCommentIdHint: 99,
  cfg: {
    piModel: "gpt-4o-mini",
    features: { ...makeTestConfig().features, reviewLabels: "off" as const },
  },
  payload: publishReviewTestPayload,
};

export function createReviewPublishGithubMock(actual: typeof reviewPublish) {
  return {
    ...actual,
    createPullRequestReviewWithComments: vi.fn(async () => ({
      id: 1,
      url: "https://example.com/review/1",
    })),
    listPullRequestReviewCommentsForReview: vi.fn(async () => [
      {
        path: "src/x.ts",
        line: 4,
        id: 99,
        url: "https://github.com/o/r/pull/1#discussion_r99",
      },
    ]),
    listPullRequestReviewComments: vi.fn(async () => ({
      comments: [
        {
          path: "src/x.ts",
          line: 4,
          id: 99,
          url: "https://github.com/o/r/pull/1#discussion_r99",
        },
      ],
      truncated: false,
    })),
    resolveVerifiedSummaryCommentRef: vi.fn(async () => null),
    findIssueCommentBySentinel: vi.fn(async () => null),
    upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
    listPullRequestLabels: vi.fn(async () => []),
    setPullRequestLabels: vi.fn(async () => undefined),
    setReviewCommitStatus: vi.fn(async () => undefined),
  };
}

export function createAgentWorkRepositoryMock() {
  return {
    claimSummaryCommentCreation: vi.fn(async () => true),
    getProgressCommentOwner: vi.fn(async () => null),
    getProgressCommentRevision: vi.fn(async () => null),
    getProgressStubPostedAtMs: vi.fn(async () => null),
    getSummaryCommentGithubId: vi.fn(async () => null),
    recordPublishStep: vi.fn(),
  };
}

export async function createReviewCheckRunMock() {
  const actual = await import("../../src/agentWork/reviewCheckRun.js");
  return {
    ...actual,
    completeReviewCheckRun: vi.fn(async () => true),
  };
}
