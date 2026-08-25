import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSurface } from "../src/github/prSurface.js";
import { createFakePrSurface } from "../src/github/prSurface.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getReviewCheckRunGithubId: vi.fn(async () => null),
  getSummaryCommentGithubId: vi.fn(async () => null),
  getWorkItemCore: vi.fn(async () => null),
  recordReviewCheckRun: vi.fn(async () => undefined),
  releaseUnstartedReviewCheckRunReservation: vi.fn(async () => true),
  reserveReviewCheckRun: vi.fn(async () => true),
}));

vi.mock("../src/evlog.js", () => ({
  logWarn: vi.fn(),
}));

import {
  getReviewCheckRunGithubId,
  getSummaryCommentGithubId,
  getWorkItemCore,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
} from "../src/agentWork/repository.js";
import { logWarn } from "../src/evlog.js";
import {
  REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
  cancelReviewCheckRun,
  cancelReviewCheckRunsForWorkItems,
  completeReviewCheckRun,
  ensureReviewCheckRunStarted,
  reviewCheckRunName,
  reviewCheckRunOutcome,
  waitForReviewCheckRunGithubId,
} from "../src/agentWork/reviewCheckRun.js";
import { DEFERRED_HEAD_SHA } from "../src/settings/index.js";

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
        externalId: "wi-1",
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
        externalId: "wi-1",
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

  it("releases the reservation when startReviewCheck returns a proven duplicate 422", async () => {
    const prSurface = makePrSurface({
      startReviewCheck: vi.fn().mockRejectedValue({
        status: 422,
        response: {
          data: {
            errors: [{ resource: "CheckRun", code: "already_exists" }],
          },
        },
      }),
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

  it("cancels a persisted check run", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    const prSurface = makePrSurface();

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(true);

    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 123,
        conclusion: "cancelled",
        summary: REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
      }),
    );
  });

  it("silently handles missing Checks permission on cancel", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    const prSurface = makePrSurface({
      finishReviewCheck: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
        ),
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("returns false and logs when cancel finish fails generically", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    const prSurface = makePrSurface({
      finishReviewCheck: vi.fn().mockRejectedValue(new Error("github unavailable")),
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);

    expect(logWarn).toHaveBeenCalledWith(
      "review_check_run_complete_failed",
      expect.objectContaining({
        checkRunId: 123,
        conclusion: "cancelled",
        message: "github unavailable",
      }),
    );
  });

  it("returns true and logs a DB record warning when cancel GitHub completion succeeds", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(123);
    vi.mocked(recordReviewCheckRun).mockRejectedValueOnce(new Error("db unavailable"));
    const prSurface = makePrSurface();

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(true);

    expect(prSurface.finishReviewCheck).toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "review_check_run_complete_record_failed",
      expect.objectContaining({
        checkRunId: 123,
        conclusion: "cancelled",
        message: "db unavailable",
      }),
    );
  });

  it("recovers an in-progress check by exact head and external id when the github id never persists", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    vi.spyOn(prSurface, "getCiStatus").mockResolvedValue({
      checkRuns: [
        {
          id: 555,
          name: "PR Agent Review",
          externalId: "wi-1",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      legacyStatuses: [],
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(true);

    expect(getReviewCheckRunGithubId).toHaveBeenCalledTimes(1);
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 555,
        conclusion: "cancelled",
      }),
    );
  });

  it("does not cancel a same-head check owned by another work item", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    vi.spyOn(prSurface, "getCiStatus").mockResolvedValue({
      checkRuns: [
        {
          id: 556,
          name: "PR Agent Review",
          externalId: "other-work-item",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      legacyStatuses: [],
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);
    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("does not cancel when the provider omits external id", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    vi.spyOn(prSurface, "getCiStatus").mockResolvedValue({
      checkRuns: [
        {
          id: 556,
          name: "PR Agent Review",
          externalId: null,
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      legacyStatuses: [],
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);
    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("does not cancel when the provider check-run view is truncated", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    vi.spyOn(prSurface, "getCiStatus").mockResolvedValue({
      checkRuns: [
        {
          id: 557,
          name: "PR Agent Review",
          externalId: "wi-1",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      checkRunsComplete: false,
      legacyStatuses: [],
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);
    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("does not cancel when exact remote identity is ambiguous", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    vi.spyOn(prSurface, "getCiStatus").mockResolvedValue({
      checkRuns: [
        {
          id: 557,
          name: "PR Agent Review",
          externalId: "wi-1",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
        {
          id: 558,
          name: "PR Agent Review",
          externalId: "wi-1",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      legacyStatuses: [],
    });

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);
    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("does not wait for a late-persisted check id on cancel", async () => {
    vi.useFakeTimers();
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    const getCiStatus = vi.spyOn(prSurface, "getCiStatus").mockResolvedValue({
      checkRuns: [],
      legacyStatuses: [],
    });

    const pending = cancelReviewCheckRun(pool, startParams(prSurface));
    await expect(pending).resolves.toBe(false);

    expect(getReviewCheckRunGithubId).toHaveBeenCalledTimes(1);
    expect(getCiStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("is safe when cancel completes the same check twice", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(123);
    const prSurface = makePrSurface();

    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(true);
    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(true);

    expect(prSurface.finishReviewCheck).toHaveBeenCalledTimes(2);
    expect(prSurface.finishReviewCheck).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ checkRunId: 123, conclusion: "cancelled" }),
    );
    expect(prSurface.finishReviewCheck).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ checkRunId: 123, conclusion: "cancelled" }),
    );
  });

  it("returns false when cancel fallback finds no open check", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    const getCiStatus = vi.spyOn(prSurface, "getCiStatus");

    getCiStatus.mockRejectedValueOnce(new Error("status boom"));
    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);

    getCiStatus.mockResolvedValueOnce({ checkRuns: [], legacyStatuses: [] });
    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);

    getCiStatus.mockResolvedValueOnce({
      checkRuns: [
        {
          id: 1,
          name: "Other Check",
          status: "in_progress",
          conclusion: null,
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      legacyStatuses: [],
    });
    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);

    getCiStatus.mockResolvedValueOnce({
      checkRuns: [
        {
          id: 2,
          name: "PR Agent Review",
          status: "completed",
          conclusion: "success",
          htmlUrl: null,
          outputTitle: null,
          outputSummary: null,
          outputText: null,
        },
      ],
      legacyStatuses: [],
    });
    await expect(cancelReviewCheckRun(pool, startParams(prSurface))).resolves.toBe(false);

    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("does not look up open checks when headSha is undefined", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    const getCiStatus = vi.spyOn(prSurface, "getCiStatus");

    await expect(
      cancelReviewCheckRun(pool, {
        ...startParams(prSurface),
        headSha: undefined,
      }),
    ).resolves.toBe(false);

    expect(getReviewCheckRunGithubId).toHaveBeenCalledTimes(1);
    expect(getCiStatus).not.toHaveBeenCalled();
    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("does not look up open checks when headSha is the deferred sentinel", async () => {
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(null);
    const prSurface = makePrSurface();
    const getCiStatus = vi.spyOn(prSurface, "getCiStatus");

    await expect(
      cancelReviewCheckRun(pool, {
        ...startParams(prSurface),
        headSha: DEFERRED_HEAD_SHA,
      }),
    ).resolves.toBe(false);

    expect(getReviewCheckRunGithubId).toHaveBeenCalledTimes(1);
    expect(getCiStatus).not.toHaveBeenCalled();
    expect(prSurface.finishReviewCheck).not.toHaveBeenCalled();
  });

  it("cancels check runs for every cancelled work item", async () => {
    vi.mocked(getWorkItemCore)
      .mockResolvedValueOnce({
        id: "wi-a",
        type: "review",
        reviewLens: "review",
        resourceKey: "o/r#1",
        headSha: "sha-a",
      } as never)
      .mockResolvedValueOnce({
        id: "wi-b",
        type: "review",
        reviewLens: "review",
        resourceKey: "o/r#1",
        headSha: "sha-b",
      } as never);
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(9);
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValueOnce(11).mockResolvedValueOnce(22);
    const prSurface = makePrSurface();

    await cancelReviewCheckRunsForWorkItems(pool, {
      prSurface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      workItemIds: ["wi-a", "wi-b"],
    });

    expect(prSurface.finishReviewCheck).toHaveBeenCalledTimes(2);
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 11, conclusion: "cancelled" }),
    );
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 22, conclusion: "cancelled" }),
    );
  });

  it("skips non-review cores and continues after a per-item cancel failure", async () => {
    vi.mocked(getWorkItemCore).mockImplementation(async (_pool, workItemId) => {
      switch (workItemId) {
        case "wi-ask":
          return {
            id: "wi-ask",
            type: "ask",
            reviewLens: null,
            resourceKey: "o/r#1",
            headSha: "sha-ask",
          } as never;
        case "wi-null-lens":
          return {
            id: "wi-null-lens",
            type: "review",
            reviewLens: null,
            resourceKey: "o/r#1",
            headSha: "sha-null",
          } as never;
        case "wi-a":
          return {
            id: "wi-a",
            type: "review",
            reviewLens: "review",
            resourceKey: "o/r#1:a",
            headSha: "sha-a",
          } as never;
        case "wi-b":
          return {
            id: "wi-b",
            type: "review",
            reviewLens: "review",
            resourceKey: "o/r#1:b",
            headSha: "sha-b",
          } as never;
        default:
          return null;
      }
    });
    vi.mocked(getSummaryCommentGithubId).mockImplementation(async (_pool, resourceKey) => {
      if (resourceKey === "o/r#1:a") return null;
      if (resourceKey === "o/r#1:b") return 9;
      return null;
    });
    vi.mocked(getReviewCheckRunGithubId).mockImplementation(async (_pool, workItemId) => {
      if (workItemId === "wi-a") return 11;
      if (workItemId === "wi-b") return 22;
      return null;
    });
    const prSurface = makePrSurface({
      finishReviewCheck: vi.fn(async (args: { checkRunId: number }) => {
        if (args.checkRunId === 11) throw new Error("first cancel boom");
      }),
    });

    await cancelReviewCheckRunsForWorkItems(pool, {
      prSurface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      workItemIds: ["wi-missing", "wi-ask", "wi-null-lens", "wi-a", "wi-b"],
    });

    expect(prSurface.finishReviewCheck).toHaveBeenCalledTimes(2);
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 11,
        conclusion: "cancelled",
        detailsUrl: undefined,
      }),
    );
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 22,
        conclusion: "cancelled",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-9",
      }),
    );
  });

  it("continues cancelling later work items when getWorkItemCore throws", async () => {
    vi.mocked(getWorkItemCore).mockImplementation(async (_pool, workItemId) => {
      if (workItemId === "wi-a") throw new Error("db read boom");
      if (workItemId === "wi-b") {
        return {
          id: "wi-b",
          type: "review",
          reviewLens: "review",
          resourceKey: "o/r#1",
          headSha: "sha-b",
        } as never;
      }
      return null;
    });
    vi.mocked(getSummaryCommentGithubId).mockResolvedValue(9);
    vi.mocked(getReviewCheckRunGithubId).mockResolvedValue(22);
    const prSurface = makePrSurface();

    await cancelReviewCheckRunsForWorkItems(pool, {
      prSurface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      workItemIds: ["wi-a", "wi-b"],
    });

    expect(logWarn).toHaveBeenCalledWith(
      "review_check_run_cancel_item_failed",
      expect.objectContaining({
        workItemId: "wi-a",
        message: "db read boom",
      }),
    );
    expect(prSurface.finishReviewCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkRunId: 22, conclusion: "cancelled" }),
    );
  });
});
