import { vi } from "vitest";
import type { ReviewPayload } from "../../src/review/reviewSchema.js";
import type * as reviewPublish from "../../src/github/reviewPublish.js";

export const publishReviewTestPayload: ReviewPayload = {
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
  estimatedEffort: 2,
  relevantTests: "no",
  securityConcerns: null,
  followUps: [],
};

export const publishReviewTestBaseParams = {
  token: "t",
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "sha",
  hasDescriptionAgentBlock: false,
  cfg: {
    enableReviewLabelsEffort: false,
    enableReviewLabelsSecurity: false,
    enableReviewCommitStatus: false,
    enableReviewCheckRun: false,
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
    getSummaryCommentGithubId: vi.fn(async () => null),
    recordPublishStep: vi.fn(),
  };
}

export function createReviewCheckRunMock() {
  return {
    completeReviewCheckRun: vi.fn(async () => true),
    reviewCheckDetailsUrl: vi.fn(
      (owner: string, repo: string, prNumber: number, summaryCommentId?: string | number | null) =>
        summaryCommentId == null
          ? undefined
          : `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`,
    ),
  };
}
