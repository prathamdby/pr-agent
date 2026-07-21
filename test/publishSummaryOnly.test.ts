import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import {
  publishReviewSummaryOnly,
  type PublishReviewSummaryOnlyArgs,
} from "../src/review/publish/publishSummaryOnly.js";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.js";
import type { ReviewFinding, ReviewPayload } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  const { createReviewPublishGithubMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewPublishGithubMock(actual);
});

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/reviewCheckRun.js", async () => {
  const { createReviewCheckRunMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewCheckRunMock();
});

import {
  listPullRequestReviewCommentsForReview,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

const findings: ReviewFinding[] = [
  {
    severity: "P1",
    file: "src/a.ts",
    startLine: 4,
    endLine: 4,
    title: "First bug",
    detail: "First detail.",
    fixPrompt: "Fix the first bug.",
  },
  {
    severity: "P2",
    file: "src/b.ts",
    startLine: 7,
    endLine: 7,
    title: "Second bug",
    detail: "Second detail.",
    fixPrompt: "Fix the second bug.",
  },
];

const payload: ReviewPayload = makeReviewPayload({ findings });
const placements: InlinePlacement[] = findings.map((finding) => ({
  finding,
  inlineLine: finding.startLine,
  inlinePosted: true,
}));

function args(overrides: Partial<PublishReviewSummaryOnlyArgs> = {}): PublishReviewSummaryOnlyArgs {
  return {
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      hasDescriptionAgentBlock: false,
    },
    getToken: () => "t",
    payload,
    summaryPlacements: placements,
    inlineReviewIds: [11, 12],
    recordPublishStep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("publishReviewSummaryOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPullRequestReviewCommentsForReview).mockImplementation(
      async (_token, _owner, _repo, _prNumber, reviewId) =>
        reviewId === 11
          ? [
              {
                path: "src/a.ts",
                line: 4,
                id: 111,
                url: "https://github.com/o/r/pull/1#discussion_r111",
              },
            ]
          : [
              {
                path: "src/b.ts",
                line: 7,
                id: 222,
                url: "https://github.com/o/r/pull/1#discussion_r222",
              },
            ],
    );
  });

  it("enriches summary links from every inline review id", async () => {
    const params = args();

    await expect(publishReviewSummaryOnly(params)).resolves.toEqual({
      summaryCommentId: 2,
    });

    expect(listPullRequestReviewCommentsForReview).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(listPullRequestReviewCommentsForReview).mock.calls.map((call) => call[4]),
    ).toEqual([11, 12]);
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("#discussion_r111");
    expect(summaryBody).toContain("#discussion_r222");
    expect(params.recordPublishStep).toHaveBeenCalledWith(
      "summary_comment",
      expect.objectContaining({ githubId: 2 }),
    );
  });

  it("renders the partial coverage note under the final summary", async () => {
    await publishReviewSummaryOnly(
      args({ partialCoverageNote: "Coverage partial: security specialist failed." }),
    );

    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("Coverage partial: security specialist failed.");
  });

  it.each([
    { staleHead: true, reason: "stale_head" },
    { staleHead: false, reason: "superseded" },
  ])("checks the $reason gate before every GitHub read or write", async ({ staleHead, reason }) => {
    const params = args({
      shouldAbortPublish: async () => true,
      publishAbortState: { staleHead },
    });

    await expect(publishReviewSummaryOnly(params)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("review.publish_superseded");
      expect((error as AppError).context).toMatchObject({ reason });
      return true;
    });
    expect(listPullRequestReviewCommentsForReview).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
  });
});
