import { sqliteReviewCoordination } from "./helpers/publishReviewTestSetup.ts";
vi.mock("../src/review/findingIdentity/threadMutationLock.ts", () => ({
  threadMutationLock: () => (apply: () => Promise<unknown>) => apply(),
}));
import { legacyFindingId } from "../src/review/findingIdentity/findingMarker.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.ts";
import { publishSummaryForTest } from "./helpers/reviewPublishTestHelpers.ts";
import type { ReviewFinding } from "../src/review/reviewSchema.ts";
import { makeTestConfig } from "./helpers/config.ts";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.ts";
import { createFakePrSurface } from "../src/github/prSurface.ts";

function configuredSummarySurface() {
  const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  bundle.controls.setReviewComments(
    [
      [10, 41],
      [20, 42],
    ].map(([line, id]) => ({
      id,
      inReplyToId: null,
      pullRequestReviewId: null,
      userId: null,
      body: "",
      path: "src/a.ts",
      line,
      originalLine: line,
      htmlUrl: `https://github.com/o/r/pull/1#discussion_r${id}`,
      authorLogin: "pr-agent[bot]",
    })),
  );
  vi.spyOn(bundle.surface, "finishReviewCheck");
  const upsertProgressComment = vi
    .spyOn(bundle.surface, "upsertProgressComment")
    .mockResolvedValue({ id: 2, updated: false });
  const setReviewCommitStatus = vi
    .spyOn(bundle.surface, "setReviewCommitStatus")
    .mockResolvedValue(undefined);
  return { ...bundle, upsertProgressComment, setReviewCommitStatus };
}

vi.mock("../src/github/reviewPublish.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.ts")>();
  return {
    ...actual,
    findIssueCommentBySentinel: vi.fn(async () => null),
    resolveVerifiedSummaryCommentRef: vi.fn(async () => null),
    upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
    listPullRequestLabels: vi.fn(async () => []),
    setPullRequestLabels: vi.fn(async () => undefined),
    setReviewCommitStatus: vi.fn(async () => undefined),
  };
});

import * as verdictSurfaces from "../src/review/publish/reviewVerdictSurfaces.ts";
import { attachSummaryCommentCoordination } from "../src/review/publish/reviewSummaryComment.ts";
import { publishCloseOutcomeReview } from "../src/review/publish/publishCloseOutcomeReview.ts";

function finding(line: number) {
  return ((pinnedReturn: ReviewFinding) => pinnedReturn)({
    severity: "P1",
    file: "src/a.ts",
    startLine: line,
    endLine: line,
    title: `Bug at line ${line}`,
    detail: `The code at line ${line} returns the wrong value.`,
    fixPrompt: `Fix src/a.ts line ${line}.`,
  });
}

describe("publishReviewSummaryOnly", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("links placements to comments from every inline review batch", async () => {
    const first = finding(10);
    const second = finding(20);
    const payload = makeReviewPayload({
      findings: [first, second],
    });
    const ledger = createFindingLedger({
      accepted: [
        {
          kind: "posted",
          source: "correctness",
          placement: { finding: first, inlineLine: 10, inlinePosted: true },
          findingId: legacyFindingId("fp-1"),
          reviewId: 41,
        },
        {
          kind: "posted",
          source: "security",
          placement: { finding: second, inlineLine: 20, inlinePosted: true },
          findingId: legacyFindingId("fp-2"),
          reviewId: 42,
        },
      ],
      inlineReviewIds: [41, 42],
      postedInlineCount: 2,
    });

    const { surface, upsertProgressComment } = configuredSummarySurface();
    const create = vi.spyOn(verdictSurfaces, "reviewVerdictSurfaces");

    const result = await publishSummaryForTest({
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

    expect(result).toEqual({
      kind: "published",
      summaryCommentId: 2,
      check: { conclusion: "failure", blockingCount: 2 },
    });
    expect(create).not.toHaveBeenCalled();
    expect(upsertProgressComment).toHaveBeenCalledTimes(1);
    const summaryBody = upsertProgressComment.mock.calls[0]?.[0];
    expect(summaryBody).toContain("#discussion_r41");
    expect(summaryBody).toContain("#discussion_r42");
    expect(summaryBody).toContain("2 findings block merge.");
    expect(summaryBody).toContain("All specialists ran except security.");
    expect(summaryBody).not.toContain("Coverage partial: security specialist failed.");
    expect(summaryBody?.indexOf("All specialists ran")).toBeLessThan(
      summaryBody?.indexOf("<table>") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("stops before the summary write when the reviewed head is stale", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: bundle.surface,
      payload: makeReviewPayload({ size: "XS" }),
      ledger: createFindingLedger(),
      shouldAbortPublish: async () => true,
      publishAbortState: { staleHead: true },
    });

    expect(result).toEqual({ kind: "stopped", reason: "stale_head" });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });

  it("propagates abort-check failures so the durable job can retry", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    const abortCheckError = new Error("temporary head lookup failure");

    await expect(
      publishSummaryForTest({
        cfg: makeTestConfig(),
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        prSurface: bundle.surface,
        payload: makeReviewPayload({ size: "XS" }),
        ledger: createFindingLedger(),
        shouldAbortPublish: async () => {
          throw abortCheckError;
        },
      }),
    ).rejects.toBe(abortCheckError);

    expect(upsertProgressComment).not.toHaveBeenCalled();
  });

  it("rejects summary publication when every specialist failed", async () => {
    const bundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
    await expect(
      publishSummaryForTest({
        cfg: makeTestConfig(),
        ctx: {
          owner: "o",
          repo: "r",
          prNumber: 1,
          headSha: "sha",
          hasDescriptionReviewMap: false,
        },
        prSurface: bundle.surface,
        payload: makeReviewPayload({ size: "XS" }),
        ledger: createFindingLedger(),
        coverage: {
          kind: "none",
          failed: ["correctness", "security", "quality", "tests"],
        },
      }),
    ).rejects.toMatchObject({ code: "review.summary_coverage_none" });
    expect(upsertProgressComment).not.toHaveBeenCalled();
  });

  it("submits an APPROVE review after a complete summary with no blockers", async () => {
    const { surface } = configuredSummarySurface();
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "APPROVE",
        commitId: "sha",
      }),
    );
    const body = publishThreadBatch.mock.calls[0]?.[0]?.body ?? "";
    expect(body).toContain(
      "No blocking findings remain. [View review summary](https://github.com/o/r/pull/1#issuecomment-2)",
    );
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("requests changes for a published failure and leaves prior verdicts standing", async () => {
    const { surface, controls } = configuredSummarySurface();
    controls.setPullRequestReviews([
      {
        id: 21,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "prior comment",
        commitId: "old",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-21",
        state: "APPROVED",
      },
    ]);
    const item = finding(10);
    const ledger = createFindingLedger({
      accepted: [
        {
          kind: "summary_only",
          source: "quality",
          placement: { finding: item, inlineLine: 10, inlinePosted: false },
          findingId: legacyFindingId("fp"),
          reason: "budget",
        },
      ],
    });
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [item] }),
      ledger,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        commitId: "sha",
        body: expect.stringContaining("1 blocking finding needs attention."),
      }),
    );
    expect(dismissPullRequestReview).not.toHaveBeenCalled();
  });

  it("comments on a partial run and dismisses this app's standing verdicts", async () => {
    const recordPublishStep = attachSummaryCommentCoordination(
      async () => undefined,
      sqliteReviewCoordination({ workItemId: "wi-1", resourceKey: "o/r#1" }),
    );
    const { surface, controls } = configuredSummarySurface();
    controls.setPullRequestReviews([
      {
        id: 11,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "older request",
        commitId: "old-1",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-11",
        state: "CHANGES_REQUESTED",
      },
      {
        id: 12,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "latest request",
        commitId: "old-2",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-12",
        state: "CHANGES_REQUESTED",
      },
      {
        id: 13,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "prior approve",
        commitId: "old-3",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-13",
        state: "APPROVED",
      },
      {
        id: 14,
        userId: 2,
        authorLogin: "human-reviewer",
        body: "human request",
        commitId: "old-4",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-14",
        state: "CHANGES_REQUESTED",
      },
    ]);
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      recordPublishStep,
      coverage: {
        kind: "partial",
        failed: ["security"],
        note: "Coverage partial: security specialist failed.",
      },
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "COMMENT",
        commitId: "sha",
        body: expect.stringContaining(
          "Review coverage was incomplete, so PR Agent did not approve.",
        ),
      }),
    );
    expect(dismissPullRequestReview.mock.calls.map((call) => call[0]?.reviewId).toSorted()).toEqual(
      [11, 12, 13],
    );
    expect(dismissPullRequestReview).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 14 }),
    );
  });

  it("falls back to COMMENT when GitHub rejects a self-authored APPROVE and then dismisses prior verdicts", async () => {
    const { surface, controls } = configuredSummarySurface();
    controls.setPullRequestReviews([
      {
        id: 31,
        userId: 1,
        authorLogin: "pr-agent[bot]",
        body: "standing approve",
        commitId: "old",
        htmlUrl: "https://github.com/o/r/pull/1#pullrequestreview-31",
        state: "APPROVED",
      },
    ]);
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    publishThreadBatch.mockRejectedValueOnce(
      Object.assign(new Error("Can not approve your own pull request"), { status: 422 }),
    );
    const dismissPullRequestReview = vi.spyOn(surface, "dismissPullRequestReview");
    const result = await publishSummaryForTest({
      cfg: makeTestConfig({
        features: { ...makeTestConfig().features, commitStatus: false, reviewLabels: "off" },
      }),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: [] }),
      ledger: createFindingLedger(),
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });
    expect(result.kind).toBe("published");
    expect(publishThreadBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: "APPROVE" }),
    );
    expect(publishThreadBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "COMMENT",
        commitId: "sha",
        body: expect.stringContaining("No blocking findings remain."),
      }),
    );
    expect(dismissPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 31 }),
    );
  });

  it("reuses the terminal review when the same work item publishes twice", async () => {
    const target = sqliteReviewCoordination({ workItemId: "wi-1", resourceKey: "o/r#1" });
    const { surface } = configuredSummarySurface();
    const publishThreadBatch = vi.spyOn(surface, "publishThreadBatch");
    const params = {
      prSurface: surface,
      outcome: { kind: "published" as const, conclusion: "success" as const, blockingCount: 0 },
      headSha: "sha",
      target,
      reviewLens: "review",
    };
    await publishCloseOutcomeReview(params);
    await publishCloseOutcomeReview(params);
    expect(publishThreadBatch).toHaveBeenCalledTimes(1);
  });
});
