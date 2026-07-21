import { describe, expect, it, vi, beforeEach } from "vitest";
import { publishReviewForTest } from "./helpers/reviewPublishTestHelpers.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { cachedDiffForLines, testPublishState } from "./helpers/reviewPublishTestHelpers.js";
import { publishReviewTestBaseParams } from "./helpers/publishReviewTestSetup.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  const { createReviewPublishGithubMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewPublishGithubMock(actual);
});

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/publishRecordRepository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/reviewCheckRun.js", async () => {
  const { createReviewCheckRunMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewCheckRunMock();
});

import {
  findIssueCommentBySentinel,
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../src/github/reviewPublish.js";
import {
  attachSummaryCommentCoordination,
  upsertSummaryCommentWithCreationClaim,
} from "../src/review/publish/publishReview.js";
import {
  claimSummaryCommentCreation,
  getSummaryCommentGithubId,
} from "../src/agentWork/publishRecordRepository.js";

const baseParams = publishReviewTestBaseParams;
const pool = {} as import("pg").Pool;
const claimBase = {
  pool,
  workItemId: "wi-1",
  resourceKey: "o/r#1",
  reviewLens: "review" as const,
  token: "t",
  owner: "o",
  repo: "r",
  prNumber: 1,
  body: "summary body",
  sentinel: REVIEW_SUMMARY_SENTINEL,
};

describe("upsertSummaryCommentWithCreationClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(null);
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(true);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue(null);
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue(null);
    vi.mocked(upsertReviewSummaryComment).mockResolvedValue({ id: 99, updated: false });
  });

  it("creates when claim won and no stored id", async () => {
    await upsertSummaryCommentWithCreationClaim(claimBase);

    expect(claimSummaryCommentCreation).toHaveBeenCalledWith(pool, "wi-1", "o/r#1", "review");
    expect(findIssueCommentBySentinel).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
  });

  it("uses stored id without scanning when verified", async () => {
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(55);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 55,
      url: "https://example.com/55",
      source: "hint",
    });

    await upsertSummaryCommentWithCreationClaim(claimBase);

    expect(claimSummaryCommentCreation).not.toHaveBeenCalled();
    expect(findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      { id: 55, url: "https://example.com/55" },
      undefined,
    );
  });

  it("updates polled id when claim lost", async () => {
    vi.useFakeTimers();
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(false);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValueOnce(null).mockResolvedValueOnce(77);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 77,
      url: "https://example.com/77",
      source: "hint",
    });

    const pending = upsertSummaryCommentWithCreationClaim(claimBase);
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;

    expect(getSummaryCommentGithubId).toHaveBeenCalled();
    expect(findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      { id: 77, url: "https://example.com/77" },
      undefined,
    );
    vi.useRealTimers();
  });

  it("creates as last resort when claim lost and poll misses", async () => {
    vi.useFakeTimers();
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(false);
    vi.mocked(findIssueCommentBySentinel).mockResolvedValue(null);

    const pending = upsertSummaryCommentWithCreationClaim(claimBase);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(findIssueCommentBySentinel).toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      "summary body",
      REVIEW_SUMMARY_SENTINEL,
      null,
      undefined,
    );
    vi.useRealTimers();
  });
});

describe("publishReview summary coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(88);
    vi.mocked(claimSummaryCommentCreation).mockResolvedValue(true);
    vi.mocked(resolveVerifiedSummaryCommentRef).mockResolvedValue({
      id: 88,
      url: "https://example.com/88",
      source: "hint",
    });
    vi.mocked(upsertReviewSummaryComment).mockResolvedValue({ id: 88, updated: true });
  });

  it("uses stored progress id without sentinel scan", async () => {
    const recordPublishStep = attachSummaryCommentCoordination(vi.fn(), {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    });

    await publishReviewForTest({
      ...baseParams,
      publishState: testPublishState(),
      cachedDiffIndex: cachedDiffForLines("src/x.ts", [4]),
      recordPublishStep,
    });

    expect(findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(upsertReviewSummaryComment).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      1,
      expect.any(String),
      REVIEW_SUMMARY_SENTINEL,
      { id: 88, url: "https://example.com/88" },
      undefined,
    );
  });
});
