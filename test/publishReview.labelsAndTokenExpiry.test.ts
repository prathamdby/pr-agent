import { describe, expect, it, vi, beforeEach } from "vitest";
import * as evlog from "../src/evlog.js";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import {
  publishReviewTestBaseParams,
  publishReviewTestPayload,
} from "./helpers/publishReviewTestSetup.js";

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
  listPullRequestLabels,
  resolveVerifiedSummaryCommentRef,
  setPullRequestLabels,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

const payload = publishReviewTestPayload;
const baseParams = publishReviewTestBaseParams;

describe("publishReview labels and token expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips setPullRequestLabels when exact effort label already exists", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: false,
        enableReviewCommitStatus: false,
        enableReviewCheckRun: false,
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
        enableReviewCommitStatus: false,
        enableReviewCheckRun: false,
      },
      payload: { ...payload, estimatedEffort: 2, securityConcerns: null },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      ["Review effort 2/5"],
      undefined,
    );
  });

  it("calls setPullRequestLabels when effort label value changes", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: false,
        enableReviewCommitStatus: false,
        enableReviewCheckRun: false,
      },
      payload: { ...payload, estimatedEffort: 4 },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      ["bug", "Review effort 4/5"],
      undefined,
    );
  });

  it("syncs quality effort without removing review effort", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce([
      "Review effort 3/5",
      "Quality effort 1/5",
      "bug",
    ]);

    await publishReviewForTest({
      ...baseParams,
      mode: "review-quality",
      publishState: testPublishState(),
      cfg: {
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: false,
        enableReviewCommitStatus: false,
        enableReviewCheckRun: false,
      },
      payload: { ...payload, estimatedEffort: 4 },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      ["Review effort 3/5", "bug", "Quality effort 4/5"],
      undefined,
    );
  });

  it("preserves unmanaged labels beyond the first GitHub page on replace-all sync", async () => {
    const pageOneExtras = Array.from({ length: 30 }, (_, i) => `extra-${i + 1}`);
    const pageTwoExtras = ["must-preserve-page-two", "also-preserve-page-two"];
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce([
      "Review effort 1/5",
      ...pageOneExtras,
      ...pageTwoExtras,
    ]);

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cfg: {
        enableReviewLabelsEffort: true,
        enableReviewLabelsSecurity: false,
        enableReviewCommitStatus: false,
        enableReviewCheckRun: false,
      },
      payload: { ...payload, estimatedEffort: 2 },
    });

    expect(setPullRequestLabels).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.arrayContaining([...pageOneExtras, ...pageTwoExtras, "Review effort 2/5"]),
      undefined,
    );
    const nextLabels = vi.mocked(setPullRequestLabels).mock.calls[0]?.[4] ?? [];
    expect(nextLabels).toHaveLength(pageOneExtras.length + pageTwoExtras.length + 1);
    expect(nextLabels).not.toContain("Review effort 1/5");
  });

  it("forwards tokenExpiresAtTs to inline review creation", async () => {
    const tokenExpiresAtTs = 1_700_000_000_000;

    await publishReviewForTest({
      ...baseParams,
      tokenExpiresAtTs,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "REQUEST_CHANGES",
        commitId: "sha",
      }),
      tokenExpiresAtTs,
    );
  });

  it("forwards tokenExpiresAtTs on repeat no-bugs review creation", async () => {
    const tokenExpiresAtTs = 1_700_000_000_000;
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValueOnce({
      id: 99,
      url: "https://github.com/o/r/pull/1#issuecomment-99",
      source: "hint",
    });

    await publishReviewForTest({
      ...baseParams,
      tokenExpiresAtTs,
      shouldLinkToSummary: true,
      summaryCommentIdHint: 99,
      publishState: testPublishState(),
      payload: { ...payload, findings: [] },
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "COMMENT",
      }),
      tokenExpiresAtTs,
    );
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
          enableReviewCommitStatus: false,
          enableReviewCheckRun: false,
        },
      }),
    ).resolves.toBeUndefined();

    expect(upsertReviewSummaryComment).toHaveBeenCalled();
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
      vi.mocked(listPullRequestLabels).mockRejectedValueOnce(rejection);

      await expect(
        publishReviewForTest({
          ...baseParams,
          publishState: testPublishState(),
          cfg: {
            enableReviewLabelsEffort: true,
            enableReviewLabelsSecurity: false,
            enableReviewCommitStatus: false,
            enableReviewCheckRun: false,
          },
        }),
      ).resolves.toBeUndefined();

      expect(upsertReviewSummaryComment).toHaveBeenCalled();
      expect(setPullRequestLabels).not.toHaveBeenCalled();
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
