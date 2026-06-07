import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import * as reviewSchema from "../src/review/reviewSchema.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import {
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
} from "../src/review/reviewSchema.js";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  REVIEW_POINTER_NOTE_LEAD,
} from "../src/review/reviewRender.js";
import {
  cachedDiffForFiles,
  cachedDiffForLines,
  testPublishState,
} from "./helpers/reviewPublishTestHelpers.js";
import { fingerprintFinding } from "../src/review/reviewFindingFingerprint.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
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
    upsertReviewSummaryComment: vi.fn(async () => ({ id: 2, updated: false })),
    listPullRequestLabels: vi.fn(async () => []),
    setPullRequestLabels: vi.fn(async () => undefined),
  };
});

import {
  createPullRequestReviewWithComments,
  listPullRequestLabels,
  listPullRequestReviewCommentsForReview,
  resolveVerifiedSummaryCommentRef,
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
    );
    expect(listPullRequestReviewCommentsForReview).toHaveBeenCalledWith("t", "o", "r", 1, 1);
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("#discussion_r99");
    expect(summaryBody).not.toContain("/blob/sha/");
    expect(publishState.inlinePublished).toBe(true);
    expect(publishState.inlineReviewId).toBe(1);
  });

  it("records auto-fix targets with inline comment ids after summary publish", async () => {
    const recordAutoFixTargets = vi.fn(async () => undefined);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordAutoFixTargets,
    });

    expect(recordAutoFixTargets).toHaveBeenCalledWith([
      expect.objectContaining({
        fingerprint: fingerprintFinding(payload.findings[0], "review"),
        placementKind: "inline",
        inlineReviewCommentId: 99,
        finding: expect.objectContaining({
          severity: "P1",
          file: "src/x.ts",
          fixPrompt: "Fix src/x.ts line 4.",
        }),
      }),
    ]);
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

  it("records summary-only auto-fix targets without inline comment ids", async () => {
    const finding = payload.findings[0];
    const stored = fingerprintFinding(finding, "review");
    const recordAutoFixTargets = vi.fn(async () => undefined);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      storedInlineFingerprints: [stored],
      recordAutoFixTargets,
    });

    expect(recordAutoFixTargets).toHaveBeenCalledWith([
      expect.objectContaining({
        placementKind: "summary",
        inlineReviewCommentId: undefined,
        finding: expect.objectContaining({ severity: "P1", file: "src/x.ts" }),
      }),
    ]);
  });

  it("preserves stored fingerprints on inline_review step when all inline suppressed", async () => {
    const finding = payload.findings[0];
    const stored = fingerprintFinding(finding, "review");
    const recordPublishStep = vi.fn(async () => undefined);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      storedInlineFingerprints: [stored],
      recordPublishStep,
    });

    const inlineStep = recordPublishStep.mock.calls.find(([step]) => step === "inline_review");
    expect(inlineStep).toBeDefined();
    const meta = inlineStep?.[1]?.meta as { fingerprints?: string[] } | undefined;
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
    );
    expect(publishState.inlinePublished).toBe(true);
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
    expect(publishState.inlinePublished).toBe(true);
  });

  it("records an empty auto-fix target set when a review publishes no eligible findings", async () => {
    const recordAutoFixTargets = vi.fn(async () => undefined);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      payload: { ...payload, findings: [] },
      recordAutoFixTargets,
    });

    expect(recordAutoFixTargets).toHaveBeenCalledWith([]);
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
    );
  });

  it("skips inline review when inlinePublished is already true", async () => {
    const publishState = testPublishState();
    publishState.inlinePublished = true;

    await publishReviewForTest({ ...baseParams, publishState });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
  });

  it("still resolves inline comment URLs when inline review was published earlier", async () => {
    const publishState = testPublishState({ inlinePublished: true, inlineReviewId: 1 });

    await publishReviewForTest({
      ...baseParams,
      publishState,
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(createPullRequestReviewWithComments).not.toHaveBeenCalled();
    expect(listPullRequestReviewCommentsForReview).toHaveBeenCalledWith("t", "o", "r", 1, 1);
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("#discussion_r99");
  });

  it("uses security sentinel and pointer with agent fix prompt when mode is review-security", async () => {
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

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
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

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: true,
      },
      payload: { ...payload, estimatedEffort: 2, securityConcerns: null },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith("t", "o", "r", 1, ["Review effort 2/5"]);
  });

  it("calls setPullRequestLabels when effort label value changes", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
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
    );
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
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
    );
    const callArgs = vi.mocked(createPullRequestReviewWithComments).mock.calls[0]?.[4];
    expect(callArgs).not.toHaveProperty("comments");
    expect(upsertReviewSummaryComment).toHaveBeenCalled();
    expect(publishState.inlinePublished).toBe(true);
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

  it("does not fail publish when label sync throws", async () => {
    vi.mocked(setPullRequestLabels).mockRejectedValueOnce(new Error("labels forbidden"));

    await expect(
      publishReviewForTest({
        ...baseParams,
        publishState: testPublishState(),
        cfg: {
          enableReviewLabelsEffort: true,
          enableReviewLabelsSecurity: false,
        },
      }),
    ).resolves.toBeUndefined();

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
    );
    expect(publishState.inlinePublished).toBe(true);
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
    );
    const summaryBody = vi.mocked(upsertReviewSummaryComment).mock.calls[0]?.[4];
    expect(summaryBody).toContain("Summary only");
    expect(summaryBody).not.toContain("Inline thread posted");
    expect(publishState.inlinePublished).toBe(true);
  });
});
