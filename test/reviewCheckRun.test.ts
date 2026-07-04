import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/github/reviewPublish.js", () => ({
  createReviewCheckRun: vi.fn(async () => ({ id: 123, url: "https://github.com/o/r/runs/123" })),
  findReviewCheckRunByName: vi.fn(async () => null),
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

import { createReviewCheckRun, findReviewCheckRunByName, updateReviewCheckRun } from "../src/github/reviewPublish.js";
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
  waitForReviewCheckRunGithubId,
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
    vi.useFakeTimers();
    vi.mocked(reserveReviewCheckRun).mockResolvedValueOnce(false);
    vi.mocked(releaseUnstartedReviewCheckRunReservation).mockResolvedValueOnce(false);
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);

    const pending = ensureReviewCheckRunStarted(pool, startParams);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();

    expect(createReviewCheckRun).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("waits for a peer-started check run id when a fresh reservation is held", async () => {
    vi.useFakeTimers();
    vi.mocked(reserveReviewCheckRun).mockResolvedValueOnce(false);
    vi.mocked(releaseUnstartedReviewCheckRunReservation).mockResolvedValueOnce(false);
    vi.mocked(getReviewCheckRunGithubId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(456);

    const pending = ensureReviewCheckRunStarted(pool, startParams);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(456);

    expect(createReviewCheckRun).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reuses an existing GitHub check when create returns a duplicate-name 422", async () => {
    vi.mocked(createReviewCheckRun).mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { status: 422 }),
    );
    vi.mocked(findReviewCheckRunByName).mockResolvedValueOnce({
      id: 789,
      url: "https://github.com/o/r/runs/789",
    });

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBe(789);

    expect(findReviewCheckRunByName).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      "sha",
      "PR Agent Review",
      123,
    );
    expect(recordReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        githubId: 789,
      }),
    );
  });

  it("releases the reservation when duplicate lookup fails after a 422", async () => {
    vi.mocked(createReviewCheckRun).mockRejectedValueOnce(
      Object.assign(new Error("already exists"), { status: 422 }),
    );
    vi.mocked(findReviewCheckRunByName).mockRejectedValueOnce(new Error("github unavailable"));

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBeNull();

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
    expect(recordReviewCheckRun).not.toHaveBeenCalled();
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

  it("waits for a persisted check run id before completing", async () => {
    vi.useFakeTimers();
    vi.mocked(getReviewCheckRunGithubId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(123);

    const pending = completeReviewCheckRun(pool, {
      ...startParams,
      conclusion: "success",
      summary: "no blocking findings",
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(true);

    expect(updateReviewCheckRun).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("polls until a check run id appears", async () => {
    vi.useFakeTimers();
    vi.mocked(getReviewCheckRunGithubId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(321);

    const pending = waitForReviewCheckRunGithubId(pool, "wi-1", "review", {
      timeoutMs: 500,
      pollMs: 100,
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(321);
    vi.useRealTimers();
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
