import { describe, expect, it, vi, beforeEach } from "vitest";
import * as evlog from "../src/evlog.js";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import {
  createPublishReviewTestHarness,
  publishReviewTestBaseParams,
  publishReviewTestPayload,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.js";

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/reviewCheckRun.js", async () => {
  const { createReviewCheckRunMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewCheckRunMock();
});

const payload = publishReviewTestPayload;
let harness: PublishReviewTestHarness;
let baseParams: ReturnType<typeof publishReviewTestBaseParams>;

describe("publishReview labels and token expiry", () => {
  beforeEach(() => {
    harness = createPublishReviewTestHarness();
    baseParams = publishReviewTestBaseParams(harness);
    vi.clearAllMocks();
  });

  it("skips label sync when reviewLabels mode is off and no category label exists", async () => {
    harness.getLabels.mockResolvedValueOnce(["bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "off" as const },
      },
    });

    expect(harness.setLabels).not.toHaveBeenCalled();
  });

  it("skips setLabels when exact effort label already exists", async () => {
    harness.getLabels.mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "effort" as const },
      },
    });

    expect(harness.setLabels).not.toHaveBeenCalled();
  });

  it("calls setLabels when effort matches but security label is stale", async () => {
    harness.getLabels.mockResolvedValueOnce(["Review effort 2/5", "Possible security concern"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "effort+security" as const },
      },
      payload: { ...payload, estimatedEffort: 2, securityConcerns: null },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(["Review effort 2/5"]);
  });

  it("calls setLabels when effort label value changes", async () => {
    harness.getLabels.mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "effort" as const },
      },
      payload: { ...payload, estimatedEffort: 4 },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(["bug", "Review effort 4/5"]);
  });

  it("uses the review effort family for a recognized legacy mode", async () => {
    harness.getLabels.mockResolvedValueOnce(["Review effort 3/5", "Quality effort 1/5", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      mode: "review-quality",
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "effort" as const },
      },
      payload: { ...payload, estimatedEffort: 4 },
    });

    expect(harness.setLabels).toHaveBeenCalledWith([
      "Quality effort 1/5",
      "bug",
      "Review effort 4/5",
    ]);
  });

  it("preserves unmanaged labels beyond the first GitHub page on replace-all sync", async () => {
    const pageOneExtras = Array.from({ length: 30 }, (_, i) => `extra-${i + 1}`);
    const pageTwoExtras = ["must-preserve-page-two", "also-preserve-page-two"];
    harness.getLabels.mockResolvedValueOnce([
      "Review effort 1/5",
      ...pageOneExtras,
      ...pageTwoExtras,
    ]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "effort" as const },
      },
      payload: { ...payload, estimatedEffort: 2 },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(
      expect.arrayContaining([...pageOneExtras, ...pageTwoExtras, "Review effort 2/5"]),
    );
    const nextLabels = harness.setLabels.mock.calls[0]?.[0] ?? [];
    expect(nextLabels).toHaveLength(pageOneExtras.length + pageTwoExtras.length + 1);
    expect(nextLabels).not.toContain("Review effort 1/5");
  });

  it("does not create a zero-comment review on repeat no-bugs publish", async () => {
    harness.resolveProgressComment.mockResolvedValueOnce({
      id: 99,
      url: "https://github.com/o/r/pull/1#issuecomment-99",
      body: "progress",
    });

    await publishReviewForTest({
      ...baseParams,
      shouldLinkToSummary: true,
      progressCommentIdHint: 99,
      publishState: testPublishState(),
      payload: { ...payload, findings: [] },
    });

    expect(harness.publishThreadBatch).not.toHaveBeenCalled();
  });

  it("does not fail publish when label sync throws", async () => {
    harness.setLabels.mockRejectedValueOnce(new Error("labels forbidden"));

    await expect(
      publishReviewForTest({
        ...baseParams,
        publishState: testPublishState(),
        cfg: {
          ...baseParams.cfg,
          features: { ...baseParams.cfg.features, reviewLabels: "effort" as const },
        },
      }),
    ).resolves.toBeUndefined();

    expect(harness.upsertProgressComment).toHaveBeenCalled();
  });

  it.each([
    {
      name: "string",
      rejection: "labels exploded",
      message: "listPullRequestLabels returned non-array: labels exploded",
    },
    {
      name: "Error",
      rejection: new Error("labels forbidden"),
      message: "labels forbidden",
    },
  ])(
    "does not fail publish when label listing rejects with $name",
    async ({ rejection, message }) => {
      const warnSpy = vi.spyOn(evlog, "logWarn").mockImplementation(() => {});
      harness.getLabels.mockRejectedValueOnce(rejection);

      await expect(
        publishReviewForTest({
          ...baseParams,
          publishState: testPublishState(),
          cfg: {
            ...baseParams.cfg,
            features: { ...baseParams.cfg.features, reviewLabels: "effort" as const },
          },
        }),
      ).resolves.toBeUndefined();

      expect(harness.upsertProgressComment).toHaveBeenCalled();
      expect(harness.setLabels).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("review_labels_fetch_failed", {
        mode: "review",
        owner: "o",
        repo: "r",
        pr: 1,
        message,
      });
      warnSpy.mockRestore();
    },
  );
});
