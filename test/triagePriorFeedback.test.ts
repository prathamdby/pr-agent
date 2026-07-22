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
  classifyReviewLensFromPointerBody,
  fetchBotFindingThreads,
  parseReviewPointerLensMarker,
} from "../src/review/run/reviewPriorFeedback.js";

describe("classifyReviewLensFromPointerBody", () => {
  it("prefers the HTML lens marker over legacy strings", () => {
    const body = `${REVIEW_POINTER_BODY}\n${renderReviewPointerLensMarker("review-security")}`;
    expect(classifyReviewLensFromPointerBody(body)).toBe("review-security");
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
});
