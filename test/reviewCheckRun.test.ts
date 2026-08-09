import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSurface } from "../src/github/prSurface.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getReviewCheckRunGithubId: vi.fn(async () => null),
  recordReviewCheckRun: vi.fn(async () => undefined),
  releaseUnstartedReviewCheckRunReservation: vi.fn(async () => true),
  reserveReviewCheckRun: vi.fn(async () => true),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

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
  reviewCheckRunOutcome,
  waitForReviewCheckRunGithubId,
} from "../src/agentWork/reviewCheckRun.js";

const pool = {} as never;

const startParamsBase = {
  owner: "o",
  repo: "r",
  prNumber: 1,
  headSha: "sha",
  workItemId: "wi-1",
  resourceKey: "o/r#1",
  reviewLens: "review" as const,
};

function makePrSurface(
  overrides: {
    startReviewCheck?: PrSurface["startReviewCheck"];
    finishReviewCheck?: PrSurface["finishReviewCheck"];
  } = {},
): PrSurface {
  const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
  vi.spyOn(surface, "startReviewCheck").mockImplementation(
    overrides.startReviewCheck ??
      (async () => ({ id: 123, url: "https://github.com/o/r/runs/123" })),
  );
  vi.spyOn(surface, "finishReviewCheck").mockImplementation(
    overrides.finishReviewCheck ?? (async () => undefined),
  );
  return surface;
}

function startParams(prSurface = makePrSurface()) {
  return { ...startParamsBase, prSurface };
}

describe("review check run lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a fixed check run name", () => {
    expect(reviewCheckRunName()).toBe("PR Agent Review");
  });

  it("fails the check when P0–P2 findings exist and passes otherwise", () => {
    expect(reviewCheckRunOutcome([{ severity: "P0" }])).toEqual({
      conclusion: "failure",
      summary: "1 finding",
    });
    expect(reviewCheckRunOutcome([{ severity: "P1" }])).toEqual({
      conclusion: "failure",
      summary: "1 finding",
    });
    expect(reviewCheckRunOutcome([{ severity: "P2" }, { severity: "P3" }])).toEqual({
      conclusion: "failure",
      summary: "1 finding",
    });
    expect(reviewCheckRunOutcome([{ severity: "P0" }, { severity: "P2" }])).toEqual({
      conclusion: "failure",
      summary: "2 findings",
    });
    expect(reviewCheckRunOutcome([])).toEqual({
      conclusion: "success",
      summary: "No findings",
    });
    expect(reviewCheckRunOutcome([{ severity: "P3" }])).toEqual({
      conclusion: "success",
      summary: "No findings",
    });
  });

  it("creates and records an in-progress check run", async () => {
    const prSurface = makePrSurface();
    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBe(123);

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
    expect(prSurface.startReviewCheck).toHaveBeenCalledWith(
      "sha",
      "wi-1",
      "PR Agent review is in progress.",
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
    const prSurface = makePrSurface();

    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBe(456);

    expect(reserveReviewCheckRun).not.toHaveBeenCalled();
    expect(prSurface.startReviewCheck).not.toHaveBeenCalled();
  });

  it("recovers a stale unstarted reservation before creating", async () => {
    vi.mocked(reserveReviewCheckRun).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const prSurface = makePrSurface();

    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBe(123);

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        staleBefore: expect.any(Date),
      }),
    );
    expect(prSurface.startReviewCheck).toHaveBeenCalledTimes(1);
  });

  it("does not release a fresh competing reservation", async () => {
    vi.useFakeTimers();
    vi.mocked(reserveReviewCheckRun).mockResolvedValueOnce(false);
    vi.mocked(releaseUnstartedReviewCheckRunReservation).mockResolvedValueOnce(false);
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();

    const pending = ensureReviewCheckRunStarted(pool, startParams(prSurface));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();

    expect(prSurface.startReviewCheck).not.toHaveBeenCalled();
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
    const prSurface = makePrSurface();

    const pending = ensureReviewCheckRunStarted(pool, startParams(prSurface));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(456);

    expect(prSurface.startReviewCheck).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("releases the reservation when startReviewCheck returns a duplicate-name 422", async () => {
    const prSurface = makePrSurface({
      startReviewCheck: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("already exists"), { status: 422 })),
    });

    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBeNull();

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
    expect(recordReviewCheckRun).not.toHaveBeenCalled();
  });

  it("releases the reservation when create fails", async () => {
    const prSurface = makePrSurface({
      startReviewCheck: vi.fn().mockRejectedValue(new Error("checks forbidden")),
    });

    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBeNull();

    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
  });

  it("silently handles missing Checks permission on create", async () => {
    const prSurface = makePrSurface({
      startReviewCheck: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
        ),
    });

    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBeNull();

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("cancels the GitHub check when recording a created check run fails", async () => {
    vi.mocked(recordReviewCheckRun).mockRejectedValueOnce(new Error("db unavailable"));
    const prSurface = makePrSurface();

    await expect(ensureReviewCheckRunStarted(pool, startParams(prSurface))).resolves.toBeNull();

    expect(prSurface.startReviewCheck).toHaveBeenCalled();
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 123,
        conclusion: "cancelled",
        summary: "PR Agent could not persist this check run.",
      }),
    );
    expect(releaseUnstartedReviewCheckRunReservation).toHaveBeenCalledWith(pool, {
      workItemId: "wi-1",
      resourceKey: "o/r#1",
      reviewLens: "review",
    });
  });

  it("completes an existing check run", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    const prSurface = makePrSurface();

    await expect(
      completeReviewCheckRun(pool, {
        ...startParams(prSurface),
        conclusion: "failure",
        summary: "1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
    ).resolves.toBe(true);

    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 123,
        name: "PR Agent Review",
        conclusion: "failure",
        summary: "1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
    );
  });

  it("waits for a persisted check run id before completing", async () => {
    vi.useFakeTimers();
    vi.mocked(getReviewCheckRunGithubId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(123);
    const prSurface = makePrSurface();

    const pending = completeReviewCheckRun(pool, {
      ...startParams(prSurface),
      conclusion: "success",
      summary: "No findings",
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(true);

    expect(prSurface.finishReviewCheck).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("polls until a check run id appears", async () => {
    vi.useFakeTimers();
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(null).mockResolvedValueOnce(321);

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
    const prSurface = makePrSurface();

    await expect(
      completeReviewCheckRun(pool, {
        ...startParams(prSurface),
        conclusion: "success",
        summary: "No findings",
      }),
    ).resolves.toBe(true);

    expect(prSurface.finishReviewCheck).toHaveBeenCalled();
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
    const prSurface = makePrSurface({
      finishReviewCheck: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
        ),
    });

    await expect(
      completeReviewCheckRun(pool, {
        ...startParams(prSurface),
        conclusion: "success",
        summary: "No findings",
      }),
    ).resolves.toBe(false);

    expect(logWarn).not.toHaveBeenCalled();
  });
});
