import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/github/reviewPublish.js", () => ({
  createReviewCheckRun: vi.fn(async () => ({ id: 123, url: "https://github.com/o/r/runs/123" })),
  updateReviewCheckRun: vi.fn(async () => undefined),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getReviewCheckRunGithubId: vi.fn(async () => null),
  recordReviewCheckRun: vi.fn(async () => undefined),
  releaseUnstartedReviewCheckRunReservation: vi.fn(async () => true),
  reserveReviewCheckRun: vi.fn(async () => true),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

import { createReviewCheckRun, updateReviewCheckRun } from "../src/github/reviewPublish.js";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
} from "../src/agentWork/repository.js";
import { logWarn } from "../src/evlog.js";
import {
  completeReviewCheckRun,
  ensureReviewCheckRunStarted,
  reviewCheckRunName,
} from "../src/agentWork/reviewCheckRun.js";

const pool = {} as never;
const cfg = { enableReviewCheckRun: true };

const startParams = {
  cfg,
  token: "tok",
  tokenExpiresAtTs: 123,
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "sha",
  workItemId: "wi-1",
  resourceKey: "o/r#1",
  reviewLens: "review" as const,
};

describe("review check run lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps review lenses to check names", () => {
    expect(reviewCheckRunName("review")).toBe("PR Agent Review");
    expect(reviewCheckRunName("review-security")).toBe("PR Agent Security Review");
    expect(reviewCheckRunName("review-quality")).toBe("PR Agent Quality Review");
    expect(reviewCheckRunName("review-tests")).toBe("PR Agent Tests Review");
  });

  it("does nothing when disabled", async () => {
    await expect(
      ensureReviewCheckRunStarted(pool, {
        ...startParams,
        cfg: { enableReviewCheckRun: false },
      }),
    ).resolves.toBeNull();

    expect(createReviewCheckRun).not.toHaveBeenCalled();
  });

  it("creates and records an in-progress check run", async () => {
    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBe(123);

    expect(reserveReviewCheckRun).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
      detail: {
        status: "starting",
        headSha: "sha",
        name: "PR Agent Review",
      },
    });
    expect(createReviewCheckRun).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      {
        name: "PR Agent Review",
        headSha: "sha",
        externalId: "wi-1",
        summary: "PR Agent review is in progress.",
      },
      123,
    );
    expect(recordReviewCheckRun).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
      githubId: 123,
      detail: {
        status: "in_progress",
        headSha: "sha",
        name: "PR Agent Review",
        htmlUrl: "https://github.com/o/r/runs/123",
      },
    });
  });

  it("does not create a duplicate when an id is already stored", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(456);

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBe(456);

    expect(reserveReviewCheckRun).not.toHaveBeenCalled();
    expect(createReviewCheckRun).not.toHaveBeenCalled();
  });

  it("recovers a stale unstarted reservation before creating", async () => {
    vi.mocked(reserveReviewCheckRun).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBe(123);

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        staleBefore: expect.any(Date),
      }),
    );
    expect(createReviewCheckRun).toHaveBeenCalledTimes(1);
  });

  it("does not release a fresh competing reservation", async () => {
    vi.mocked(reserveReviewCheckRun).mockResolvedValueOnce(false);
    vi.mocked(releaseUnstartedReviewCheckRunReservation).mockResolvedValueOnce(false);

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBeNull();

    expect(createReviewCheckRun).not.toHaveBeenCalled();
  });

  it("releases the reservation when create fails", async () => {
    vi.mocked(createReviewCheckRun).mockRejectedValueOnce(new Error("checks forbidden"));

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBeNull();

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
  });

  it("silently handles missing Checks permission on create", async () => {
    vi.mocked(createReviewCheckRun).mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBeNull();

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("cancels the GitHub check when recording a created check run fails", async () => {
    vi.mocked(recordReviewCheckRun).mockRejectedValueOnce(new Error("db unavailable"));

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBeNull();

    expect(createReviewCheckRun).toHaveBeenCalled();
    expect(updateReviewCheckRun).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      123,
      expect.objectContaining({
        conclusion: "cancelled",
        summary: "PR Agent could not persist this check run.",
      }),
      123,
    );
    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
  });

  it("completes an existing check run", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);

    await expect(
      completeReviewCheckRun(pool, {
        ...startParams,
        conclusion: "failure",
        summary: "1 P0/P1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
    ).resolves.toBe(true);

    expect(updateReviewCheckRun).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      123,
      expect.objectContaining({
        name: "PR Agent Review",
        conclusion: "failure",
        summary: "1 P0/P1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
      123,
    );
  });

  it("returns true and logs a DB record warning when GitHub completion succeeds", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    vi.mocked(recordReviewCheckRun).mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      completeReviewCheckRun(pool, {
        ...startParams,
        conclusion: "success",
        summary: "no blocking findings",
      }),
    ).resolves.toBe(true);

    expect(updateReviewCheckRun).toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "review_check_run_complete_record_failed",
      expect.objectContaining({
        checkRunId: 123,
        message: "db unavailable",
      }),
    );
  });

  it("silently handles missing Checks permission on update", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    vi.mocked(updateReviewCheckRun).mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );

    await expect(
      completeReviewCheckRun(pool, {
        ...startParams,
        conclusion: "success",
        summary: "no blocking findings",
      }),
    ).resolves.toBe(false);

    expect(logWarn).not.toHaveBeenCalled();
  });
});
