import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReview } from "../src/agent/publishReview.js";
import * as reviewSchema from "../src/agent/reviewSchema.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";
import {
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
} from "../src/agent/reviewSchema.js";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  SECURITY_REVIEW_POINTER_BODY,
} from "../src/agent/reviewRender.js";

vi.mock("../src/github/reviewPublish.js", () => ({
  createPullRequestReviewWithComments: vi.fn(async () => ({
    id: 1,
    url: "https://example.com/review/1",
  })),
  resolveVerifiedSummaryCommentUrl: vi.fn(async () => undefined),
  upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
  listPullRequestLabels: vi.fn(async () => []),
  setPullRequestLabels: vi.fn(async () => undefined),
}));

import {
  createPullRequestReviewWithComments,
  listPullRequestLabels,
  resolveVerifiedSummaryCommentUrl,
  setPullRequestLabels,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

const payload: ReviewPayload = {
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

const baseParams = {
  token: "t",
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "sha",
  cfg: {
    maxReviewFindings: 8,
    enableReviewLabelsEffort: false,
    enableReviewLabelsSecurity: false,
  },
  payload,
};

describe("publishReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses REQUEST_CHANGES for P1 and passes inline comments with agent fix prompt body", async () => {
    const publishState = { published: false, inlinePublished: false, lastValidationError: null };
    await publishReview({ ...baseParams, publishState });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        body: expect.stringContaining(AGENT_FIX_PROMPT_ACCORDION_SUMMARY),
        comments: [
          expect.objectContaining({
            path: "src/x.ts",
            line: 4,
            side: "RIGHT",
          }),
        ],
      }),
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlinePublished).toBe(true);
  });

  it("bases review event on full findings not inline subset", async () => {
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
        title: "P1 hidden from inline cap",
        detail: "d",
        fixPrompt: "fix",
      },
    ];

    await publishReview({
      ...baseParams,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
      cfg: {
        maxReviewFindings: 1,
        enableReviewLabelsEffort: false,
        enableReviewLabelsSecurity: false,
      },
      payload: { ...payload, findings },
    });

    expect(spy).toHaveBeenCalledWith(findings);
    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
    spy.mockRestore();
  });

  it.each([
    { label: "general", mode: undefined, sentinel: REVIEW_SUMMARY_SENTINEL },
    {
      label: "security",
      mode: "review-security" as const,
      sentinel: SECURITY_REVIEW_SUMMARY_SENTINEL,
    },
  ])("skips PR review when there are no P0–P2 findings ($label)", async ({ mode, sentinel }) => {
    const publishState = { published: false, inlinePublished: false, lastValidationError: null };

    await publishReview({
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
    );
    expect(publishState.inlinePublished).toBe(true);
  });

  it("skips PR review when only P3 findings", async () => {
    const publishState = { published: false, inlinePublished: false, lastValidationError: null };

    await publishReview({
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
    expect(publishState.inlinePublished).toBe(true);
  });

  it("uses COMMENT when only P2 findings", async () => {
    await publishReview({
      ...baseParams,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
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
    );
  });

  it("skips inline review when inlinePublished is already true", async () => {
    const publishState = { published: false, inlinePublished: false, lastValidationError: null };
    publishState.inlinePublished = true;

    await publishReview({ ...baseParams, publishState });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
  });

  it("uses security sentinel and pointer with agent fix prompt when mode is review-security", async () => {
    const publishState = { published: false, inlinePublished: false, lastValidationError: null };
    await publishReview({
      ...baseParams,
      mode: "review-security",
      publishState,
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        body: expect.stringContaining(SECURITY_REVIEW_POINTER_BODY),
      }),
    );
    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        body: expect.stringContaining(AGENT_FIX_PROMPT_ACCORDION_SUMMARY),
      }),
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.stringContaining(SECURITY_REVIEW_SUMMARY_SENTINEL),
      SECURITY_REVIEW_SUMMARY_SENTINEL,
    );
  });

  it("skips setPullRequestLabels when exact effort label already exists", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReview({
      ...baseParams,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
      cfg: {
        maxReviewFindings: 8,
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: false,
      },
    });

    expect(setPullRequestLabels).not.toHaveBeenCalled();
  });

  it("calls setPullRequestLabels when effort matches but security label is stale", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce([
      "Review effort 2/5",
      "Possible security concern",
    ]);

    await publishReview({
      ...baseParams,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
      cfg: {
        maxReviewFindings: 8,
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: true,
      },
      payload: { ...payload, estimatedEffort: 2, securityConcerns: null },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith("t", "o", "r", 1, ["Review effort 2/5"]);
  });

  it("calls setPullRequestLabels when effort label value changes", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReview({
      ...baseParams,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
      cfg: {
        maxReviewFindings: 8,
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: false,
      },
      payload: { ...payload, estimatedEffort: 4 },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith("t", "o", "r", 1, [
      "bug",
      "Review effort 4/5",
    ]);
  });

  it("links pointer when shouldLinkToSummary and comment verifies", async () => {
    vi.mocked(resolveVerifiedSummaryCommentUrl).mockResolvedValueOnce(
      "https://github.com/o/r/pull/1#issuecomment-99",
    );

    await publishReview({
      ...baseParams,
      shouldLinkToSummary: true,
      summaryCommentIdHint: 99,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
    });

    expect(resolveVerifiedSummaryCommentUrl).toHaveBeenCalled();
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
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
  });

  it("falls back to plain pointer when shouldLinkToSummary but no verified comment", async () => {
    vi.mocked(resolveVerifiedSummaryCommentUrl).mockResolvedValueOnce(undefined);

    await publishReview({
      ...baseParams,
      shouldLinkToSummary: true,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        body: expect.stringContaining("See the structured review summary in the PR conversation."),
      }),
    );
  });

  it("posts repeat no-bugs COMMENT review when shouldLinkToSummary and zero findings", async () => {
    vi.mocked(resolveVerifiedSummaryCommentUrl).mockResolvedValueOnce(
      "https://github.com/o/r/pull/1#issuecomment-99",
    );
    const publishState = { published: false, inlinePublished: false, lastValidationError: null };

    await publishReview({
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
    );
    const callArgs = vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[4];
    expect(callArgs).not.toHaveProperty("comments");
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlinePublished).toBe(true);
  });

  it("does not post repeat no-bugs review when shouldLinkToSummary but P3-only findings", async () => {
    vi.mocked(resolveVerifiedSummaryCommentUrl).mockResolvedValueOnce(
      "https://github.com/o/r/pull/1#issuecomment-99",
    );

    await publishReview({
      ...baseParams,
      shouldLinkToSummary: true,
      publishState: { published: false, inlinePublished: false, lastValidationError: null },
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

  it("does not fail publish when label sync throws", async () => {
    vi.mocked(setPullRequestLabels).mockRejectedValueOnce(new Error("labels forbidden"));

    await expect(
      publishReview({
        ...baseParams,
        publishState: { published: false, inlinePublished: false, lastValidationError: null },
        cfg: {
          maxReviewFindings: 8,
          enableReviewLabelsEffort: true,
          enableReviewLabelsSecurity: false,
        },
      }),
    ).resolves.toBeUndefined();

    expect(upsertReviewSummaryComment).toHaveBeenCalled();
  });
});
