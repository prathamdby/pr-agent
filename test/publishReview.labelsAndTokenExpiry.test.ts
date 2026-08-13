import { describe, expect, it, vi, beforeEach } from "vitest";
import * as evlog from "../src/evlog.js";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import {
  createPublishReviewTestHarness,
  publishReviewTestBaseParams,
  publishReviewTestPayload,
  spyPublishReviewRepositories,
  type PublishReviewTestHarness,
} from "./helpers/publishReviewTestSetup.js";

const payload = publishReviewTestPayload;
let harness: PublishReviewTestHarness;
let baseParams: ReturnType<typeof publishReviewTestBaseParams>;

describe("publishReview labels and token expiry", () => {
  beforeEach(() => {
    spyPublishReviewRepositories();
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

  it("skips setLabels when exact size label already exists", async () => {
    harness.getLabels.mockResolvedValueOnce(["size:S", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "size" as const },
      },
    });

    expect(harness.setLabels).not.toHaveBeenCalled();
  });

  it("calls setLabels when size matches but security label is stale", async () => {
    harness.getLabels.mockResolvedValueOnce(["size:S", "Possible security concern"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "size+security" as const },
      },
      payload: { ...payload, size: "S", securityConcerns: null },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(["size:S"]);
  });

  it("calls setLabels when size label value changes", async () => {
    harness.getLabels.mockResolvedValueOnce(["size:S", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "size" as const },
      },
      payload: { ...payload, size: "L" },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(["bug", "size:L"]);
  });

  it("syncs the size label for a recognized legacy mode", async () => {
    harness.getLabels.mockResolvedValueOnce(["size:M", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      mode: "review-quality",
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "size" as const },
      },
      payload: { ...payload, size: "L" },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(["bug", "size:L"]);
  });

  it("preserves unmanaged labels beyond the first GitHub page on replace-all sync", async () => {
    const pageOneExtras = Array.from({ length: 30 }, (_, i) => `extra-${i + 1}`);
    const pageTwoExtras = ["must-preserve-page-two", "also-preserve-page-two"];
    harness.getLabels.mockResolvedValueOnce(["size:XS", ...pageOneExtras, ...pageTwoExtras]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        ...baseParams.cfg,
        features: { ...baseParams.cfg.features, reviewLabels: "size" as const },
      },
      payload: { ...payload, size: "S" },
    });

    expect(harness.setLabels).toHaveBeenCalledWith(
      expect.arrayContaining([...pageOneExtras, ...pageTwoExtras, "size:S"]),
    );
    const nextLabels = harness.setLabels.mock.calls[0]?.[0] ?? [];
    expect(nextLabels).toHaveLength(pageOneExtras.length + pageTwoExtras.length + 1);
    expect(nextLabels).not.toContain("size:XS");
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
          features: { ...baseParams.cfg.features, reviewLabels: "size" as const },
        },
      }),
    ).resolves.toBeUndefined();

    expect(harness.upsertProgressComment).toHaveBeenCalled();
  });

  it.each([
    {
      name: "string",
      rejection: "labels exploded",
      message: "Non-error thrown",
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
            features: { ...baseParams.cfg.features, reviewLabels: "size" as const },
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
