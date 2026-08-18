import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_NOTE_LEAD,
  VERIFICATION_STUB_MARKER,
} from "../src/settings/index.js";
import { LEGACY_REVIEW_POINTER_BODIES } from "../src/settings/legacyReviewLenses.js";
import { renderReviewPointerLensMarker } from "../src/review/run/reviewRender.js";

const [, QUALITY_REVIEW_POINTER_BODY, TESTS_REVIEW_POINTER_BODY] = LEGACY_REVIEW_POINTER_BODIES;

const mocks = vi.hoisted(() => ({
  listReviews: vi.fn(),
  listReviewComments: vi.fn(),
}));

vi.mock("../src/github/appAuth.js", () => ({
  installationOctokit: vi.fn(() => ({
    rest: {
      pulls: {
        listReviews: mocks.listReviews,
        listReviewComments: mocks.listReviewComments,
      },
    },
  })),
}));

import {
  assembleBotReviewThreads,
  classifyReviewLensFromPointerBody,
  mapAssembledThreadsToBotFindings,
  parseReviewPointerLensMarker,
  priorFeedbackLensesForSelection,
  type ReviewThreadComment,
} from "../src/review/run/reviewPriorFeedback.js";
import { fetchBotFindingThreads } from "../src/github/reviewPriorFeedbackIo.js";
import { MAX_PRIOR_INLINE_REPLY_CHARS } from "../src/settings/index.js";

describe("classifyReviewLensFromPointerBody", () => {
  it("prefers the HTML lens marker over legacy strings", () => {
    const body = `${REVIEW_POINTER_BODY}\n${renderReviewPointerLensMarker("review-security")}`;
    expect(classifyReviewLensFromPointerBody(body)).toBe("review-security");
  });

  it("recognizes the specialist Files-tab body via the lens marker", () => {
    const body = [
      "> [!NOTE]",
      "> Track this run on the [progress stub](https://example.test#issuecomment-1) in the PR conversation.",
      "",
      "`security` Here's what the security found.",
      renderReviewPointerLensMarker("review"),
    ].join("\n");
    expect(classifyReviewLensFromPointerBody(body)).toBe("review");
  });

  it("classifies legacy pointer strings", () => {
    expect(classifyReviewLensFromPointerBody(REVIEW_POINTER_BODY)).toBe("review");
    expect(classifyReviewLensFromPointerBody(QUALITY_REVIEW_POINTER_BODY)).toBe("review-quality");
    expect(classifyReviewLensFromPointerBody(TESTS_REVIEW_POINTER_BODY)).toBe("review-tests");
  });

  it("returns null for NOTE_LEAD-only bodies", () => {
    expect(classifyReviewLensFromPointerBody(REVIEW_POINTER_NOTE_LEAD)).toBeNull();
  });
});

describe("parseReviewPointerLensMarker", () => {
  it("parses all four lenses from the marker", () => {
    for (const lens of ["review", "review-security", "review-quality", "review-tests"] as const) {
      expect(parseReviewPointerLensMarker(renderReviewPointerLensMarker(lens))).toBe(lens);
    }
  });
});

describe("fetchBotFindingThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects bot-rooted findings for all four lenses including review-tests", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [
        { id: 10, user: { id: 99 }, body: REVIEW_POINTER_BODY },
        { id: 11, user: { id: 99 }, body: QUALITY_REVIEW_POINTER_BODY },
        { id: 12, user: { id: 99 }, body: TESTS_REVIEW_POINTER_BODY },
      ],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 1,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P1** · **Null user**\nbody",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/1",
        },
        {
          id: 2,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 7 },
          body: "please fix",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/2",
        },
        {
          id: 3,
          in_reply_to_id: null,
          pull_request_review_id: 12,
          user: { id: 99 },
          body: "**P2** · **Add test**",
          path: "test/app.test.ts",
          line: 1,
          original_line: 1,
          html_url: "https://github.test/3",
        },
      ],
    });

    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99)).resolves.toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        lens: "review",
        path: "src/app.ts",
        severity: "P1",
        humanReplies: ["please fix"],
      }),
      expect.objectContaining({
        rootCommentId: 3,
        lens: "review-tests",
        path: "test/app.test.ts",
      }),
    ]);
  });

  it("backfills lens from publish_records when the review body has no lens signal", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [{ id: 20, user: { id: 99 }, body: `${REVIEW_POINTER_NOTE_LEAD}\n\nmore text` }],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 4,
          in_reply_to_id: null,
          pull_request_review_id: 20,
          user: { id: 99 },
          body: "**P1** · **Leak**",
          path: "src/leak.ts",
          line: 2,
          original_line: 2,
          html_url: "https://github.test/4",
        },
      ],
    });

    const publishRecords = new Map<number, "review-security">([[20, "review-security"]]);
    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99, publishRecords)).resolves.toEqual([
      expect.objectContaining({
        rootCommentId: 4,
        lens: "review-security",
      }),
    ]);
  });

  it("excludes reviews with indeterminate lens and no publish_records backfill", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [{ id: 30, user: { id: 99 }, body: REVIEW_POINTER_NOTE_LEAD }],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 5,
          in_reply_to_id: null,
          pull_request_review_id: 30,
          user: { id: 99 },
          body: "**P2** · **Maybe**",
          path: "src/maybe.ts",
          line: 1,
          original_line: 1,
          html_url: "https://github.test/5",
        },
      ],
    });

    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99)).resolves.toEqual([]);
  });

  it("prefers the newest marked verification stub over older marked stubs", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [{ id: 10, user: { id: 99 }, body: REVIEW_POINTER_BODY }],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 1,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P1** · **Null user**\nbody",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/1",
        },
        {
          id: 11,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: `${VERIFICATION_STUB_MARKER}\n**Verification**: Still open - old`,
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/11",
        },
        {
          id: 22,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: `${VERIFICATION_STUB_MARKER}\n**Verification**: Still open - new`,
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/22",
        },
      ],
    });

    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99)).resolves.toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        verificationStubCommentId: 22,
      }),
    ]);
  });

  it("falls back to the newest legacy **Verification**: reply when no marker exists", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [{ id: 10, user: { id: 99 }, body: REVIEW_POINTER_BODY }],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 1,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P1** · **Null user**\nbody",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/1",
        },
        {
          id: 11,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**Verification**: Still open - old",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/11",
        },
        {
          id: 22,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**Verification**: Dismissed - intentional",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/22",
        },
      ],
    });

    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99)).resolves.toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        verificationStubCommentId: 22,
      }),
    ]);
  });

  it("omits verificationStubCommentId when the thread has no bot verification replies", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [{ id: 10, user: { id: 99 }, body: REVIEW_POINTER_BODY }],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 1,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P1** · **Null user**\nbody",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/1",
        },
        {
          id: 2,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 7 },
          body: "please fix",
          path: "src/app.ts",
          line: 5,
          original_line: 5,
          html_url: "https://github.test/2",
        },
      ],
    });

    const threads = await fetchBotFindingThreads("tok", "o", "r", 1, 99);
    expect(threads).toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        humanReplies: ["please fix"],
      }),
    ]);
    expect(threads[0]).not.toHaveProperty("verificationStubCommentId");
  });

  it("groups nested replies, keeps bot-only threads, and orders by path then line", async () => {
    mocks.listReviews.mockResolvedValue({
      data: [{ id: 10, user: { id: 99 }, body: REVIEW_POINTER_BODY }],
    });
    mocks.listReviewComments.mockResolvedValue({
      data: [
        {
          id: 30,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P2** · **Later file**",
          path: "src/z.ts",
          line: 9,
          original_line: 9,
          html_url: "https://github.test/30",
        },
        {
          id: 1,
          in_reply_to_id: null,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "**P1** · **Nested**",
          path: "src/a.ts",
          line: 2,
          original_line: 2,
          html_url: "https://github.test/1",
        },
        {
          id: 2,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 7 },
          body: "first human",
          path: "src/a.ts",
          line: 2,
          original_line: 2,
          html_url: "https://github.test/2",
        },
        {
          id: 3,
          in_reply_to_id: 2,
          pull_request_review_id: 10,
          user: { id: 7 },
          body: "nested human",
          path: "src/a.ts",
          line: 2,
          original_line: 2,
          html_url: "https://github.test/3",
        },
        {
          id: 4,
          in_reply_to_id: 1,
          pull_request_review_id: 10,
          user: { id: 99 },
          body: "bot follow-up",
          path: "src/a.ts",
          line: 2,
          original_line: 2,
          html_url: "https://github.test/4",
        },
      ],
    });

    await expect(fetchBotFindingThreads("tok", "o", "r", 1, 99)).resolves.toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        path: "src/a.ts",
        line: 2,
        humanReplies: ["first human", "nested human"],
      }),
      expect.objectContaining({
        rootCommentId: 30,
        path: "src/z.ts",
        humanReplies: [],
      }),
    ]);
  });

  it("treats a missing parent as its own root and breaks reply cycles", () => {
    const comments: ReviewThreadComment[] = [
      {
        id: 10,
        inReplyToId: 11,
        pullRequestReviewId: 20,
        userId: 99,
        body: "**P1** · **Cycle**",
        path: "src/a.ts",
        line: 1,
        originalLine: 1,
        htmlUrl: "https://github.test/10",
      },
      {
        id: 11,
        inReplyToId: 10,
        pullRequestReviewId: 20,
        userId: 7,
        body: "human in cycle",
        path: "src/a.ts",
        line: 1,
        originalLine: 1,
        htmlUrl: "https://github.test/11",
      },
      {
        id: 12,
        inReplyToId: 999,
        pullRequestReviewId: 20,
        userId: 99,
        body: "**P2** · **Orphan bot**",
        path: "src/b.ts",
        line: 3,
        originalLine: 3,
        htmlUrl: "https://github.test/12",
      },
    ];
    const assembled = assembleBotReviewThreads(comments, {
      botUserId: 99,
      reviewLenses: new Map([[20, "review"]]),
      allowedLenses: priorFeedbackLensesForSelection("review"),
    });
    expect(mapAssembledThreadsToBotFindings(assembled, 99)).toEqual([
      expect.objectContaining({
        rootCommentId: 10,
        path: "src/a.ts",
        humanReplies: ["human in cycle"],
      }),
      expect.objectContaining({
        rootCommentId: 12,
        path: "src/b.ts",
        humanReplies: [],
      }),
    ]);
  });

  it("truncates human replies and excludes threads whose lens is outside the selection", () => {
    const longReply = "y".repeat(MAX_PRIOR_INLINE_REPLY_CHARS + 8);
    const comments: ReviewThreadComment[] = [
      {
        id: 1,
        inReplyToId: null,
        pullRequestReviewId: 10,
        userId: 99,
        body: "**P1** · **Security**",
        path: "src/sec.ts",
        line: 1,
        originalLine: 1,
        htmlUrl: "https://github.test/1",
      },
      {
        id: 2,
        inReplyToId: 1,
        pullRequestReviewId: 10,
        userId: 7,
        body: longReply,
        path: "src/sec.ts",
        line: 1,
        originalLine: 1,
        htmlUrl: "https://github.test/2",
      },
      {
        id: 3,
        inReplyToId: null,
        pullRequestReviewId: 11,
        userId: 99,
        body: "**P2** · **Quality**",
        path: "src/qual.ts",
        line: 1,
        originalLine: 1,
        htmlUrl: "https://github.test/3",
      },
    ];
    const securityOnly = mapAssembledThreadsToBotFindings(
      assembleBotReviewThreads(comments, {
        botUserId: 99,
        reviewLenses: new Map([
          [10, "review-security"],
          [11, "review-quality"],
        ]),
        allowedLenses: priorFeedbackLensesForSelection("review-security"),
      }),
      99,
    );
    expect(securityOnly).toEqual([
      expect.objectContaining({
        rootCommentId: 1,
        lens: "review-security",
        path: "src/sec.ts",
      }),
    ]);
    expect(securityOnly[0]?.humanReplies[0]).toHaveLength(MAX_PRIOR_INLINE_REPLY_CHARS);
    expect(securityOnly.some((thread) => thread.lens === "review-quality")).toBe(false);
  });
});
