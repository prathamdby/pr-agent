import { vi, type Mock } from "vitest";
import type { ReviewPayload } from "../../src/review/reviewSchema.js";
import { createFakePrSurface, type FakePrSurfaceControls } from "../../src/github/prSurface.js";
import type { PrSurface, ThreadBatchReview } from "../../src/github/prSurface.js";
import * as repo from "../../src/agentWork/repository.js";
import * as reviewCheckRun from "../../src/agentWork/reviewCheckRun.js";
import { makeReviewPayload } from "./reviewPayloadFactory.js";
import { makeTestConfig } from "./config.js";
import type { AnyReviewLens } from "../../src/settings/legacyReviewLenses.js";

export const publishReviewTestPayload: ReviewPayload = makeReviewPayload({
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
});

export type PublishReviewTestHarness = {
  readonly surface: PrSurface;
  readonly controls: FakePrSurfaceControls;
  readonly publishThreadBatch: Mock<PrSurface["publishThreadBatch"]>;
  readonly listPullRequestReviewComments: Mock<PrSurface["listPullRequestReviewComments"]>;
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

  const listPullRequestReviewComments = vi
    .spyOn(bundle.surface, "listPullRequestReviewComments")
    .mockImplementation(async () => ({
      comments: [
        {
          path: "src/x.ts",
          line: 4,
          id: 99,
          url: "https://github.com/o/r/pull/1#discussion_r99",
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
  const getLabels = vi.spyOn(bundle.surface, "getLabels");
  const setLabels = vi.spyOn(bundle.surface, "setLabels");
  const setReviewCommitStatus = vi.spyOn(bundle.surface, "setReviewCommitStatus");

  return {
    surface: bundle.surface,
    controls: bundle.controls,
    publishThreadBatch,
    listPullRequestReviewComments,
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

export type PublishReviewTestBaseParams = {
  prSurface: PrSurface;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  hasDescriptionReviewMap: boolean;
  progressCommentIdHint: number;
  cfg: {
    piModel: string;
    features: ReturnType<typeof makeTestConfig>["features"];
  };
  payload: ReviewPayload;
  mode?: AnyReviewLens;
};

export function publishReviewTestBaseParams(
  harness: PublishReviewTestHarness,
): PublishReviewTestBaseParams {
  return {
    prSurface: harness.surface,
    owner: "o",
    repo: "r",
    prNumber: 1,
    headSha: "sha",
    hasDescriptionReviewMap: false,
    progressCommentIdHint: 99,
    cfg: {
      piModel: "gpt-4o-mini",
      features: { ...makeTestConfig().features, reviewLabels: "off" as const },
    },
    payload: publishReviewTestPayload,
  };
}

export function spyPublishReviewRepositories(): void {
  vi.spyOn(repo, "claimSummaryCommentCreation").mockResolvedValue(true);
  vi.spyOn(repo, "getProgressCommentOwner").mockResolvedValue(null);
  vi.spyOn(repo, "getProgressCommentRevision").mockResolvedValue(null);
  vi.spyOn(repo, "getProgressStubPostedAtMs").mockResolvedValue(null);
  vi.spyOn(repo, "getSummaryCommentGithubId").mockResolvedValue(null);
  vi.spyOn(repo, "recordPublishStep").mockResolvedValue(undefined);
  vi.spyOn(reviewCheckRun, "completeReviewCheckRun").mockResolvedValue(true);
}
