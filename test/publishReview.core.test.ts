import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import * as reviewSchema from "../src/review/reviewSchema.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  REVIEW_POINTER_NOTE_LEAD,
} from "../src/review/run/reviewRender.js";
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

  it("uses REQUEST_CHANGES for P1 and passes inline comments with agent fix prompt body", async () => {
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
        event: "REQUEST_CHANGES",
        body: expect.stringContaining(AGENT_FIX_PROMPT_ACCORDION_SUMMARY),
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

  it("preserves stored fingerprints on inline_review step when all inline suppressed", async () => {
    const finding = payload.findings[0];
    const stored = fingerprintFinding(finding, "review");
    const recordPublishStep = vi.fn<RecordPublishStep>(async () => undefined);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      storedInlineFingerprints: [stored],
      recordPublishStep,
    });

    const inlineStep = recordPublishStep.mock.calls.find(([step]) => step === "inline_review");
    expect(inlineStep).toBeDefined();
    const meta = inlineStep?.[1]?.meta;
    expect(meta?.fingerprints).toEqual([stored]);
  });

  it("bases review event on full findings list", async () => {
    const spy = vi.spyOn(reviewSchema, "reviewEventForFindings");
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

    expect(spy).toHaveBeenCalledWith([findings[1], findings[0]]);
    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        comments: expect.arrayContaining([
          expect.objectContaining({ path: "a.ts" }),
          expect.objectContaining({ path: "b.ts" }),
        ]),
      }),
      undefined,
    );
    spy.mockRestore();
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

  it("skips PR review when only P3 findings", async () => {
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
          },
        ],
      },
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlineReviewIds).toEqual([]);
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
        body: expect.stringContaining(REVIEW_POINTER_NOTE_LEAD),
      }),
      undefined,
    );
    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        body: expect.stringContaining(AGENT_FIX_PROMPT_ACCORDION_SUMMARY),
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
      expect.objectContaining({
        body: expect.stringContaining(
          "[View the updated review.](https://github.com/o/r/pull/1#issuecomment-99)",
        ),
      }),
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
        body: expect.stringContaining(REVIEW_POINTER_NOTE_LEAD),
      }),
      undefined,
    );
  });

  it("posts repeat no-bugs COMMENT review when shouldLinkToSummary and zero findings", async () => {
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

    expect(createPullRequestReviewWithComments).toHaveBeenCalledTimes(1);
    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "COMMENT",
        body: "No bugs found, [see the updated review](https://github.com/o/r/pull/1#issuecomment-99).",
      }),
      undefined,
    );
    const callArgs = vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[4];
    expect(callArgs).not.toHaveProperty("comments");
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlineReviewIds).toEqual([1]);
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

  it("publishes summary when GitHub rejects inline review", async () => {
    vi.mocked(createPullRequestReviewWithComments).mockRejectedValueOnce(
      new Error("Line could not be resolved"),
    );
    const publishState = testPublishState();

    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.not.stringContaining("Line could not be resolved"),
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("Summary only");
    expect(summaryBody).not.toContain("Inline thread posted");
    expect(publishState.inlineReviewIds).toEqual([]);
  });
});
