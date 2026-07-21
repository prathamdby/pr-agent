import { describe, expect, it, vi, beforeEach } from "vitest";
import * as evlog from "../src/evlog.js";
import {
  publishReviewSummaryOnly,
  type PublishReviewSummaryOnlyArgs,
} from "../src/review/publish/publishSummaryOnly.js";
import { publishFindingBatch } from "../src/review/publish/publishFindingBatch.js";
import { cachedDiffForLines } from "./helpers/reviewPublishTestHelpers.js";
import {
  publishReviewTestBaseParams,
  publishReviewTestPayload,
} from "./helpers/publishReviewTestSetup.js";
import { makeTestConfig } from "./helpers/config.js";

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
  setPullRequestLabels,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";

const payload = publishReviewTestPayload;
const baseParams = publishReviewTestBaseParams;

function summaryArgs(
  overrides: Partial<PublishReviewSummaryOnlyArgs> = {},
): PublishReviewSummaryOnlyArgs {
  const findings = overrides.payload?.findings ?? payload.findings;
  return {
    cfg: makeTestConfig({ features: { ...makeTestConfig().features, reviewLabels: "effort" } }),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      hasDescriptionAgentBlock: false,
    },
    getToken: () => "t",
    payload,
    summaryPlacements: findings.map((finding) => ({
      finding,
      inlineLine: finding.startLine,
      inlinePosted: true,
    })),
    inlineReviewIds: [1],
    recordPublishStep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("publishReviewSummaryOnly labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips label sync when reviewLabels mode is off and no category label exists", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["bug"]);

    await publishReviewSummaryOnly(
      summaryArgs({
        cfg: {
          ...baseParams.cfg,
          features: { ...baseParams.cfg.features, reviewLabels: "off" as const },
        },
      }),
    );

    expect(setPullRequestLabels).not.toHaveBeenCalled();
  });

  it("skips setPullRequestLabels when exact effort label already exists", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce(["Review effort 2/5", "bug"]);

    await publishReviewSummaryOnly(summaryArgs());

    expect(setPullRequestLabels).not.toHaveBeenCalled();
  });

  it("calls setPullRequestLabels when effort matches but security label is stale", async () => {
    vi.mocked(listPullRequestLabels).mockResolvedValueOnce([
      "Review effort 2/5",
      "Possible security concern",
    ]);

    await publishReviewSummaryOnly(
      summaryArgs({
        cfg: {
          ...baseParams.cfg,
          features: { ...baseParams.cfg.features, reviewLabels: "effort+security" as const },
        },
        payload: { ...payload, estimatedEffort: 2, securityConcerns: null },
      }),
    );

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

    await publishReviewSummaryOnly(
      summaryArgs({
        payload: { ...payload, estimatedEffort: 4 },
      }),
    );

    expect(setPullRequestLabels).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      ["bug", "Review effort 4/5"],
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

    await publishReviewSummaryOnly(
      summaryArgs({
        payload: { ...payload, estimatedEffort: 2 },
      }),
    );

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

  it("does not fail publish when label sync throws", async () => {
    vi.mocked(setPullRequestLabels).mockRejectedValueOnce(new Error("labels forbidden"));

    await expect(publishReviewSummaryOnly(summaryArgs())).resolves.toEqual({
      summaryCommentId: expect.any(Number),
    });

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

      await expect(publishReviewSummaryOnly(summaryArgs())).resolves.toEqual({
        summaryCommentId: expect.any(Number),
      });

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

describe("publishFindingBatch token expiry forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards tokenExpiresAtTs to inline review creation", async () => {
    const tokenExpiresAtTs = 1_700_000_000_000;
    const finding = payload.findings[0]!;

    await publishFindingBatch([finding], {
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken: () => "t",
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep: vi.fn(async () => undefined),
      runState: {
        postedFingerprints: new Set(),
        postedInlineCount: 0,
        batchCount: 0,
        inlineReviewIds: [],
        acceptedFindings: [],
        partialSpecialists: [],
      },
      tokenExpiresAtTs,
    });

    expect(createPullRequestReviewWithComments).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.objectContaining({
        event: "COMMENT",
        commitId: "sha",
      }),
      tokenExpiresAtTs,
    );
  });

  it("forwards tokenExpiresAtTs on repeat no-bugs review creation", async () => {
    const tokenExpiresAtTs = 1_700_000_000_000;

    await publishFindingBatch([], {
      cfg: makeTestConfig(),
      ctx: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        headSha: "sha",
        hasDescriptionAgentBlock: false,
      },
      getToken: () => "t",
      recordPublishStep: vi.fn(async () => undefined),
      runState: {
        postedFingerprints: new Set(),
        postedInlineCount: 0,
        batchCount: 0,
        inlineReviewIds: [],
        acceptedFindings: [],
        partialSpecialists: [],
      },
      tokenExpiresAtTs,
      shouldLinkToSummary: true,
      summaryCommentUrl: "https://github.com/o/r/pull/1#issuecomment-99",
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
});
