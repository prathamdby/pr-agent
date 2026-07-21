import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.js";
import type { ReviewFinding, ReviewPayload } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  return {
    ...actual,
    listPullRequestReviewCommentsForReview: vi.fn(
      async (_token, _owner, _repo, _pullNumber, reviewId: number) => {
        const line = reviewId === 41 ? 10 : 20;
        return [
          {
            path: "src/a.ts",
            line,
            id: reviewId,
            url: `https://github.com/o/r/pull/1#discussion_r${reviewId}`,
          },
        ];
      },
    ),
    resolveVerifiedSummaryCommentRef: vi.fn(async () => null),
    upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
    listPullRequestLabels: vi.fn(async () => []),
    setPullRequestLabels: vi.fn(async () => undefined),
    setReviewCommitStatus: vi.fn(async () => undefined),
  };
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

function finding(line: number): ReviewFinding {
  return {
    severity: "P1",
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Bug at line ${line}`,
    detail: `The code at line ${line} returns the wrong value.`,
    fixPrompt: `Fix src/a.ts line ${line}.`,
  };
}

describe("publishReviewSummaryOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links placements to comments from every inline review batch", async () => {
    const first = finding(10);
    const second = finding(20);
    const payload: ReviewPayload = {
      prCharacter: "Two findings.",
      findings: [first, second],
      estimatedEffort: 2,
      relevantTests: "yes",
      securityConcerns: null,
      followUps: [],
    };
    const ledger = createFindingLedger({
      accepted: [
        {
          kind: "posted",
          source: "correctness",
          placement: { finding: first, inlineLine: 10, inlinePosted: true },
          canonicalFingerprint: "fp-1",
          reviewId: 41,
        },
        {
          kind: "posted",
          source: "security",
          placement: { finding: second, inlineLine: 20, inlinePosted: true },
          canonicalFingerprint: "fp-2",
          reviewId: 42,
        },
      ],
      inlineReviewIds: [41, 42],
      postedInlineCount: 2,
    });

    const result = await publishReviewSummaryOnly({
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
      ledger,
      partialCoverageNote: "Coverage partial: security specialist failed.",
    });

    expect(result).toEqual({ kind: "published", summaryCommentId: 2 });
    expect(listPullRequestReviewCommentsForReview).toHaveBeenCalledTimes(2);
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("#discussion_r41");
    expect(summaryBody).toContain("#discussion_r42");
    expect(summaryBody).toContain("Coverage partial: security specialist failed.");
    expect(summaryBody?.indexOf("Coverage partial")).toBeGreaterThan(
      summaryBody?.indexOf("</table>") ?? -1,
    );
  });

  it("stops before the summary write when the reviewed head is stale", async () => {
    const result = await publishReviewSummaryOnly({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken: () => "t",
      payload: {
        prCharacter: "No findings.",
        findings: [],
        estimatedEffort: 1,
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      },
      ledger: createFindingLedger(),
      shouldAbortPublish: async () => true,
      publishAbortState: { staleHead: true },
    });

    expect(result).toEqual({ kind: "stopped", reason: "stale_head" });
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
  });
});
