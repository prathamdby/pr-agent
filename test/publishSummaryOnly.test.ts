import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { publishReviewSummaryOnly } from "../src/review/publish/publishSummaryOnly.js";
import type { ReviewFinding, ReviewPayload } from "../src/review/reviewSchema.js";
import { makeTestConfig } from "./helpers/config.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

function configuredSummarySurface() {
  const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  vi.spyOn(bundle.surface, "listPullRequestReviewComments").mockResolvedValue({
    comments: [
      {
        path: "src/a.ts",
        line: 10,
        id: 41,
        url: "https://github.com/o/r/pull/1#discussion_r41",
      },
      {
        path: "src/a.ts",
        line: 20,
        id: 42,
        url: "https://github.com/o/r/pull/1#discussion_r42",
      },
    ],
    truncated: false,
  });
  const upsertProgressComment = vi
    .spyOn(bundle.surface, "upsertProgressComment")
    .mockResolvedValue({ id: 2, updated: false });
  const setReviewCommitStatus = vi
    .spyOn(bundle.surface, "setReviewCommitStatus")
    .mockResolvedValue(undefined);
  return { ...bundle, upsertProgressComment, setReviewCommitStatus };
}

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  return {
    ...actual,
    listPullRequestReviewComments: vi.fn(async () => ({
      comments: [
        {
          path: "src/a.ts",
          line: 10,
          id: 41,
          url: "https://github.com/o/r/pull/1#discussion_r41",
        },
        {
          path: "src/a.ts",
          line: 20,
          id: 42,
          url: "https://github.com/o/r/pull/1#discussion_r42",
        },
      ],
      truncated: false,
    })),
    findIssueCommentBySentinel: vi.fn(async () => null),
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

import { completeReviewCheckRun } from "../src/agentWork/reviewCheckRun.js";
import { attachSummaryCommentCoordination } from "../src/review/publish/publishSummaryOnly.js";
import type { Pool, PoolClient } from "pg";

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
      size: "S",
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

    const { surface, upsertProgressComment } = configuredSummarySurface();

    const result = await publishReviewSummaryOnly({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload,
      ledger,
      coverage: {
        kind: "partial",
        failed: ["security"],
        note: "Coverage partial: security specialist failed.",
      },
    });

    expect(result).toEqual({ kind: "published", summaryCommentId: 2 });
    expect(upsertProgressComment).toHaveBeenCalledTimes(1);
    const summaryBody = upsertProgressComment.mock.calls[0]?.[0];
    expect(summaryBody).toContain("#discussion_r41");
    expect(summaryBody).toContain("#discussion_r42");
    expect(summaryBody).toContain("Coverage partial: security specialist failed.");
    expect(summaryBody?.indexOf("Coverage partial")).toBeGreaterThan(
      summaryBody?.indexOf("</table>") ?? -1,
    );
  });

  it("stops before the summary write when the reviewed head is stale", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    const result = await publishReviewSummaryOnly({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: bundle.surface,
      payload: {
        prCharacter: "No findings.",
        findings: [],
        size: "XS",
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      },
      ledger: createFindingLedger(),
      shouldAbortPublish: async () => true,
      publishAbortState: { staleHead: true },
    });

    expect(result).toEqual({ kind: "stopped", reason: "stale_head" });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });

  it("forces a neutral check and error commit status for partial coverage", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const recordPublishStep = attachSummaryCommentCoordination(async () => undefined, {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    const { surface, setReviewCommitStatus, upsertProgressComment } = configuredSummarySurface();
    const result = await publishReviewSummaryOnly({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: true, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: {
        prCharacter: "One finding with partial coverage.",
        findings: [finding(10)],
        size: "S",
        relevantTests: "partial",
        securityConcerns: null,
        followUps: [],
      },
      ledger: createFindingLedger(),
      recordPublishStep,
      coverage: {
        kind: "partial",
        failed: ["security"],
        note: "Coverage partial: security specialist failed.",
      },
    });

    expect(result.kind).toBe("published");
    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      recordPublishStep.summaryCommentCoordination?.pool,
      expect.objectContaining({
        prSurface: surface,
        conclusion: "neutral",
        summary: "Coverage partial: security specialist failed.",
      }),
    );
    expect(setReviewCommitStatus).toHaveBeenCalledWith(
      "sha",
      expect.objectContaining({ state: "error" }),
    );
    expect(upsertProgressComment).toHaveBeenCalled();
  });

  it("rejects summary publication when every specialist failed", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    await expect(
      publishReviewSummaryOnly({
        cfg: makeTestConfig(),
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        prSurface: bundle.surface,
        payload: {
          prCharacter: "No coverage.",
          findings: [],
          size: "XS",
          relevantTests: "no",
          securityConcerns: null,
          followUps: [],
        },
        ledger: createFindingLedger(),
        coverage: {
          kind: "none",
          failed: ["correctness", "security", "quality", "tests"],
        },
      }),
    ).rejects.toMatchObject({ code: "review.summary_coverage_none" });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });
});
