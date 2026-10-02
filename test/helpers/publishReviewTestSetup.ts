import { vi, type Mock } from "vitest";
import type { ReviewPayload } from "../../src/review/reviewSchema.js";
import { createFakePrSurface, type FakePrSurfaceControls } from "../../src/github/prSurface.js";
import type { PrSurface, ThreadBatchReview } from "../../src/github/prSurface.js";
import { makeReviewPayload } from "./reviewPayloadFactory.js";
import { makeTestConfig } from "./config.js";

export const publishReviewTestPayload: ReviewPayload = makeReviewPayload({
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
});

export type PublishReviewTestHarness = {
  readonly surface: PrSurface;
  readonly controls: FakePrSurfaceControls;
  readonly publishThreadBatch: Mock<PrSurface["publishThreadBatch"]>;
  readonly listReviewComments: Mock<PrSurface["listReviewComments"]>;
  readonly upsertProgressComment: Mock<PrSurface["upsertProgressComment"]>;
  readonly resolveProgressComment: Mock<PrSurface["resolveProgressComment"]>;
  readonly findProgressComment: Mock<PrSurface["findProgressComment"]>;
  readonly getLabels: Mock<PrSurface["getLabels"]>;
  readonly setLabels: Mock<PrSurface["setLabels"]>;
  readonly setReviewCommitStatus: Mock<PrSurface["setReviewCommitStatus"]>;
};

export function createPublishReviewTestHarness(options?: {
  readonly labels?: readonly string[];
}): PublishReviewTestHarness {
  const bundle = createFakePrSurface(
    { owner: "o", repo: "r", prNumber: 1 },
    options?.labels ? { labels: options.labels } : undefined,
  );
  let nextReviewId = 1;

  const listReviewComments = vi
    .spyOn(bundle.surface, "listReviewComments")
    .mockImplementation(async () => ({
      comments: [
        {
          id: 99,
          inReplyToId: null,
          pullRequestReviewId: null,
          userId: null,
          body: "",
          path: "src/x.ts",
          line: 4,
          originalLine: 4,
          htmlUrl: "https://github.com/o/r/pull/1#discussion_r99",
          authorLogin: "pr-agent[bot]",
        },
      ],
      truncated: false,
    }));

  const publishThreadBatch = vi
    .spyOn(bundle.surface, "publishThreadBatch")
    .mockImplementation(async (_review: ThreadBatchReview) => {
      const reviewId = nextReviewId++;
      return {
        reviewId,
        reviewUrl: `https://github.com/o/r/pull/1#pullrequestreview-${reviewId}`,
      };
    });

  const upsertProgressComment = vi.spyOn(bundle.surface, "upsertProgressComment");
  const resolveProgressComment = vi.spyOn(bundle.surface, "resolveProgressComment");
  const findProgressComment = vi.spyOn(bundle.surface, "findProgressComment");
  vi.spyOn(bundle.surface, "finishReviewCheck");
  const getLabels = vi.spyOn(bundle.surface, "getLabels");
  const setLabels = vi.spyOn(bundle.surface, "setLabels");
  const setReviewCommitStatus = vi.spyOn(bundle.surface, "setReviewCommitStatus");

  return {
    surface: bundle.surface,
    controls: bundle.controls,
    publishThreadBatch,
    listReviewComments,
    upsertProgressComment,
    resolveProgressComment,
    findProgressComment,
    getLabels,
    setLabels,
    setReviewCommitStatus,
  };
}

/** @deprecated Prefer createPublishReviewTestHarness().surface */
export function makePublishReviewTestPrSurface() {
  return createPublishReviewTestHarness().surface;
}

export function publishReviewTestBaseParams(
  harness: PublishReviewTestHarness,
  overrides: Record<string, unknown> = {},
) {
  return {
    prSurface: harness.surface,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "sha",
    hasDescriptionReviewMap: false,
    progressCommentIdHint: 99,
    cfg: makeTestConfig({ features: { reviewLabels: "off" } }),
    payload: publishReviewTestPayload,
    ...overrides,
  };
}

export function createPublishRecordReadMock() {
  return {
    claimSummaryCommentCreation: vi.fn(async () => true),
    getProgressCommentOwner: vi.fn(async () => null),
    getReviewCheckRunGithubId: vi.fn(async () => 111),
    getProgressCommentRevision: vi.fn(async () => null),
    getProgressStubPostedAtMs: vi.fn(async () => null),
    getSummaryCommentGithubId: vi.fn(async () => null),
  };
}

export function createOwnVerdictCloseMock() {
  let selected: unknown;
  return {
    getOwnVerdictCloseRecord: vi.fn(async () => ({
      selected,
      githubId: 111,
      checkApplied: false,
      statusApplied: false,
    })),
    withOwnVerdictClose: vi.fn(
      async (client: unknown, _params: unknown, apply: (client: unknown) => unknown) =>
        apply(client),
    ),
    claimOwnVerdict: vi.fn(async (_client: unknown, params: { selected: unknown }) => {
      selected = params.selected;
      return { selected, githubId: 111, checkApplied: false, statusApplied: false };
    }),
    recordOwnVerdictSurfaceApplied: vi.fn(async () => undefined),
  };
}
