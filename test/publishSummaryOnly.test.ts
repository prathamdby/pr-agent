import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import {
  publishReviewSummaryOnly,
  reviewCommitStatusState,
  type PublishReviewSummaryOnlyArgs,
} from "../src/review/publish/publishSummaryOnly.js";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.js";
import type { ReviewFinding, ReviewPayload } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";
import { testTokenHandle } from "./helpers/tokenHandle.js";

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
  setPullRequestLabels,
  setReviewCommitStatus,
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
    token: testTokenHandle({ token: "t" }),
    payload,
    summaryPlacements: placements,
    inlineReviewIds: [11, 12],
    recordPublishStep: vi.fn(async () => undefined),
    abortGate: async () => "continue",
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

  it("sets the commit status to error with a partial-coverage description under partial coverage", async () => {
    const cfg = makeTestConfig({
      features: { ...makeTestConfig().features, commitStatus: true },
    });
    await publishReviewSummaryOnly(
      args({
        cfg,
        coveragePartial: true,
        partialCoverageNote: "Coverage partial: security specialist failed.",
      }),
    );

    expect(setReviewCommitStatus).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      "sha",
      expect.objectContaining({ state: "error", description: "2 findings (coverage partial)" }),
      expect.any(Number),
    );
  });

  it("never maps partial coverage to a success commit status even with no findings", async () => {
    const cfg = makeTestConfig({
      features: { ...makeTestConfig().features, commitStatus: true },
    });
    await publishReviewSummaryOnly(
      args({ cfg, payload: makeReviewPayload({ findings: [] }), coveragePartial: true }),
    );

    const call = vi.mocked(setReviewCommitStatus).mock.calls[0]?.[4];
    expect(call?.state).toBe("error");
  });

  it("maps a cancelled check conclusion to an error commit status, not success", () => {
    expect(reviewCommitStatusState("cancelled")).toBe("error");
    expect(reviewCommitStatusState("success")).toBe("success");
    expect(reviewCommitStatusState("neutral")).toBe("error");
    expect(reviewCommitStatusState("failure")).toBe("failure");
  });

  it.each([
    { gate: "stale_head" as const, reason: "stale_head" },
    { gate: "superseded" as const, reason: "superseded" },
  ])("checks the $reason gate before every GitHub read or write", async ({ gate, reason }) => {
    const params = args({
      abortGate: async () => gate,
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

  it("refreshes InstallationTokenHandle before each GitHub write group", async () => {
    // Exactly three write groups with this setup: summary, commit status, labels
    // (no coordinated check run).
    const cfg = makeTestConfig({
      features: { ...makeTestConfig().features, commitStatus: true, reviewLabels: "effort" },
    });
    const calls = { n: 0 };
    const liveHandle = testTokenHandle({
      token: "t0",
      refreshNearExpiry: async () => {
        calls.n += 1;
        liveHandle.token = `t${calls.n}`;
      },
    });

    await publishReviewSummaryOnly(
      args({
        cfg,
        token: liveHandle,
      }),
    );

    expect(calls.n).toBe(3);
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t1",
      "o",
      "r",
      1,
      expect.any(String),
      expect.any(String),
      null,
      liveHandle.expiresAtTs,
    );
    expect(setReviewCommitStatus).toHaveBeenCalledWith(
      "t2",
      "o",
      "r",
      "sha",
      expect.objectContaining({ state: expect.any(String) }),
      liveHandle.expiresAtTs,
    );
    expect(setPullRequestLabels).toHaveBeenCalledWith(
      "t3",
      "o",
      "r",
      1,
      expect.any(Array),
      liveHandle.expiresAtTs,
    );
  });
});
