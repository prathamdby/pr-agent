import { vi } from "vitest";
import type { ReviewPayload } from "../../src/review/reviewSchema.js";
import type * as reviewPublish from "../../src/github/reviewPublish.js";
import { makeReviewPayload } from "./reviewPayloadFactory.js";

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
  hasDescriptionAgentBlock: false,
  cfg: {
    piModel: "gpt-4o-mini",
    enableReviewLabelsEffort: false,
    enableReviewLabelsSecurity: false,
    enableReviewCommitStatus: false,
    enableReviewCiSummary: false,
    reviewCiSummaryWaitMs: 0,
    reviewCiSummaryWaitPollMs: 2_000,
    reviewCiSummaryMaxFailures: 3,
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

export async function createReviewCheckRunMock() {
  const actual = await import("../../src/agentWork/reviewCheckRun.js");
  return {
    ...actual,
    completeReviewCheckRun: vi.fn(async () => true),
  };
}
