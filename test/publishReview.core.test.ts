import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { REVIEW_POINTER_BODY } from "../src/settings/index.js";
import {
  cachedDiffForFiles,
  cachedDiffForLines,
  testPublishState,
} from "./helpers/reviewPublishTestHelpers.js";
import { fingerprintFinding } from "../src/review/findings/reviewFindingFingerprint.js";
import {
  publishReviewTestBaseParams,
  publishReviewTestPayload,
} from "./helpers/publishReviewTestSetup.js";

type RecordPublishStep = NonNullable<
  Parameters<typeof publishReviewForTest>[0]["recordPublishStep"]
>;

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
  createPullRequestReviewWithComments,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

const payload = publishReviewTestPayload;
const baseParams = publishReviewTestBaseParams;

describe("publishReview core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses COMMENT for P1 and publishes the incremental review pointer", async () => {
    const publishState = testPublishState();
    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "COMMENT",
        body: expect.stringContaining(REVIEW_POINTER_BODY),
        commitId: "sha",
        comments: [
          expect.objectContaining({
            path: "src/x.ts",
            line: 4,
            side: "RIGHT",
          }),
        ],
      }),
      undefined,
    );
    expect(listPullRequestReviewCommentsForReview).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      1,
      undefined,
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("#discussion_r99");
    expect(summaryBody).not.toContain("/blob/sha/");
    expect(publishState.inlineReviewIds).toEqual([1]);
  });

  it("suppresses inline review when stored fingerprint matches", async () => {
    const finding = payload.findings[0];
    const stored = fingerprintFinding(finding, "review");

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      storedInlineFingerprints: [stored],
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("Summary only");
    expect(summaryBody).toContain("Bug");
  });

  it("keeps a later finding summary-only after resuming eight thread calls", async () => {
    const publishState = testPublishState({ threadCallCount: 8 });

    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4]).toContain("Summary only");
    expect(publishState.threadCallCount).toBe(9);
  });

  it("does not record a zero-comment inline review when all findings are suppressed", async () => {
    const finding = payload.findings[0];
    const stored = fingerprintFinding(finding, "review");
    const recordPublishStep = vi.fn<RecordPublishStep>(async () => undefined);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      storedInlineFingerprints: [stored],
      workItemId: "wi-test",
      recordPublishStep,
    });

    expect(recordPublishStep).not.toHaveBeenCalledWith("inline_review", expect.anything());
  });

  it("publishes all inline findings in one COMMENT batch", async () => {
    const findings: ReviewPayload["findings"] = [
      {
        severity: "P2",
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        title: "P2 only",
        detail: "d",
        fixPrompt: "fix",
      },
      {
        severity: "P1",
        file: "b.ts",
        startLine: 2,
        endLine: 2,
        title: "P1 also inline",
        detail: "d",
        fixPrompt: "fix",
      },
    ];

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForFiles([
        { file: "a.ts", lines: [1] },
        { file: "b.ts", lines: [2] },
      ]),
      payload: { ...payload, findings },
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "COMMENT",
        comments: expect.arrayContaining([
          expect.objectContaining({ path: "a.ts" }),
          expect.objectContaining({ path: "b.ts" }),
        ]),
      }),
      undefined,
    );
  });

  it.each([
    { label: "general", mode: undefined, sentinel: REVIEW_SUMMARY_SENTINEL },
    {
      label: "security",
      mode: "review-security" as const,
      sentinel: REVIEW_SUMMARY_SENTINEL,
    },
  ])("skips PR review when there are no P0–P2 findings ($label)", async ({ mode, sentinel }) => {
    const publishState = testPublishState();

    await publishReviewForTest({
      ...baseParams,
      ...(mode ? { mode } : {}),
      publishState,
      payload: { ...payload, findings: [] },
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.stringContaining(sentinel),
      sentinel,
      null,
      undefined,
    );
    expect(publishState.inlineReviewIds).toEqual([]);
  });

  it("skips PR review when only unanchored P3 findings", async () => {
    const publishState = testPublishState();

    await publishReviewForTest({
      ...baseParams,
      publishState,
      payload: {
        ...payload,
        findings: [
          {
            severity: "P3",
            file: "README.md",
            startLine: 1,
            endLine: 1,
            title: "Typo",
            detail: "minor",
            fixPrompt: "Fix the typo.",
          },
        ],
      },
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlineReviewIds).toEqual([]);
  });

  it("posts inline review for anchored P3 findings", async () => {
    const publishState = testPublishState();

    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      payload: {
        ...payload,
        findings: [
          {
            severity: "P3",
            file: "src/x.ts",
            startLine: 4,
            endLine: 4,
            title: "Minor polish",
            detail: "Advisory nits on the new line.",
            fixPrompt: "Tidy the advisory copy.",
          },
        ],
      },
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlineReviewIds).not.toEqual([]);
  });

  it("uses COMMENT when only P2 findings", async () => {
    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      payload: {
        ...payload,
        findings: [{ ...payload.findings[0], severity: "P2" }],
      },
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({ event: "COMMENT" }),
      undefined,
    );
  });

  it("loads inline comments from every resumed review batch", async () => {
    const stored = fingerprintFinding(payload.findings[0], "review");
    const publishState = testPublishState({
      inlineReviewIds: [41, 42],
    });

    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      storedInlineFingerprints: [stored],
      resumedPlacements: [
        {
          kind: "resumed",
          source: "review",
          placement: {
            finding: payload.findings[0],
            inlineLine: 4,
            inlinePosted: true,
          },
          canonicalFingerprint: stored,
          reviewId: 41,
        },
      ],
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(listPullRequestReviewCommentsForReview).toHaveBeenCalledTimes(2);
    expect(listPullRequestReviewCommentsForReview).toHaveBeenNthCalledWith(
      1,
      "t",
      "o",
      "r",
      1,
      41,
      undefined,
    );
    expect(listPullRequestReviewCommentsForReview).toHaveBeenNthCalledWith(
      2,
      "t",
      "o",
      "r",
      1,
      42,
      undefined,
    );
    expect(publishState.inlineReviewIds).toEqual([41, 42]);
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4] ?? "";
    expect(summaryBody.match(/Bug/g)).toHaveLength(1);
  });

  it("uses the general sentinel and pointer for recognized legacy modes", async () => {
    const publishState = testPublishState();
    await publishReviewForTest({
      ...baseParams,
      mode: "review-security",
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        body: expect.stringContaining(REVIEW_POINTER_BODY),
        event: "COMMENT",
      }),
      undefined,
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.stringContaining(REVIEW_SUMMARY_SENTINEL),
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
  });

  it("links pointer when shouldLinkToSummary and comment verifies", async () => {
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValueOnce({
      id: 99,
      url: "https://github.com/o/r/pull/1#issuecomment-99",
      source: "hint",
    });

    await publishReviewForTest({
      ...baseParams,
      shouldLinkToSummary: true,
      summaryCommentIdHint: 99,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(resolveVerifiedSummaryCommentRef).toHaveBeenCalled();
    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({ body: expect.stringContaining(REVIEW_POINTER_BODY) }),
      undefined,
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.any(String),
      REVIEW_SUMMARY_SENTINEL,
      { id: 99, url: "https://github.com/o/r/pull/1#issuecomment-99" },
      undefined,
    );
  });

  it("falls back to plain pointer when shouldLinkToSummary but no verified comment", async () => {
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValueOnce(null);

    await publishReviewForTest({
      ...baseParams,
      shouldLinkToSummary: true,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        body: expect.stringContaining(REVIEW_POINTER_BODY),
      }),
      undefined,
    );
  });

  it("does not create a zero-comment review when a repeated run has no findings", async () => {
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValueOnce({
      id: 99,
      url: "https://github.com/o/r/pull/1#issuecomment-99",
      source: "hint",
    });
    const publishState = testPublishState();

    await publishReviewForTest({
      ...baseParams,
      shouldLinkToSummary: true,
      summaryCommentIdHint: 99,
      publishState,
      payload: { ...payload, findings: [] },
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlineReviewIds).toEqual([]);
  });

  it("does not post repeat no-bugs review when shouldLinkToSummary but P3-only findings", async () => {
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValueOnce({
      id: 99,
      url: "https://github.com/o/r/pull/1#issuecomment-99",
      source: "hint",
    });

    await publishReviewForTest({
      ...baseParams,
      shouldLinkToSummary: true,
      publishState: testPublishState(),
      payload: {
        ...payload,
        findings: [
          {
            severity: "P3",
            file: "README.md",
            startLine: 1,
            endLine: 1,
            title: "Typo",
            detail: "minor",
            fixPrompt: "Fix the typo.",
          },
        ],
      },
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
  });

  it("publishes summary when inline anchors are invalid", async () => {
    const publishState = testPublishState();
    await publishReviewForTest({ ...baseParams, publishState });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.stringContaining("Summary only"),
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
    expect(publishState.inlineReviewIds).toEqual([]);
  });

  it("skips the summary when the final publish gate stops V1", async () => {
    const publishState = testPublishState();
    const shouldAbortPublish = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      shouldAbortPublish,
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
    expect(publishState.publishSuperseded).toBe(true);
  });

  it("propagates arbitrary GitHub inline publish failures", async () => {
    vi.mocked(createPullRequestReviewWithComments).mockRejectedValueOnce(
      new Error("GitHub unavailable"),
    );
    const publishState = testPublishState();

    await expect(
      publishReviewForTest({
        ...baseParams,
        publishState,
        cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      }),
    ).rejects.toThrow("GitHub unavailable");

    expect(upsertReviewSummaryComment).not.toHaveBeenCalled();
    expect(publishState.inlineReviewIds).toEqual([]);
  });
});
