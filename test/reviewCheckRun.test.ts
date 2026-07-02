import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/github/reviewPublish.js", () => ({
  createReviewCheckRun: vi.fn(async () => ({ id: 123, url: "https://github.com/o/r/runs/123" })),
  updateReviewCheckRun: vi.fn(async () => undefined),
}));

vi.mock("../src/agentWork/repository.js", () => ({
  getReviewCheckRunGithubId: vi.fn(async () => null),
  recordReviewCheckRun: vi.fn(async () => undefined),
  releaseUnstartedReviewCheckRunReservation: vi.fn(async () => undefined),
  reserveReviewCheckRun: vi.fn(async () => true),
}));

import { createReviewCheckRun, updateReviewCheckRun } from "../src/github/reviewPublish.js";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
} from "../src/agentWork/repository.js";
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

  it("releases the reservation when create fails", async () => {
    vi.mocked(createReviewCheckRun).mockRejectedValueOnce(new Error("checks forbidden"));

    await expect(ensureReviewCheckRunStarted(pool, startParams)).resolves.toBeNull();

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
  });

  it("keeps the reservation when recording a created check run fails", async () => {
    vi.mocked(recordReviewCheckRun).mockRejectedValueOnce(new Error("db unavailable"));

    await expect(ensureReviewCheckRunStarted(pool, startParams)).rejects.toThrow("db unavailable");

    expect(createReviewCheckRun).toHaveBeenCalled();
    expect(releaseUnstartedReviewCheckRunReservation).not.toHaveBeenCalled();
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
});
