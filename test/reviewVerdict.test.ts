import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrSurface } from "../src/github/prSurface.ts";
import {
  availableInstallationCapabilities,
  createReviewCapabilityPolicy,
} from "../src/github/installationCapabilities.ts";
import {
  closeOutcomeForCoverage,
  githubReviewEventFromCloseOutcome,
  ownVerdictFromSummaryDetail,
  ownVerdictSurfaces,
  REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
  reviewCheckRunName,
  summaryCommentVerdictMeta,
} from "../src/agentWork/reviewVerdict.ts";
import { reviewVerdictSurfaces } from "../src/review/publish/reviewVerdictSurfaces.ts";
import { FINDING_INVENTORY_UNAVAILABLE_NOTE } from "../src/review/statusCopy.ts";
import { DEFERRED_HEAD_SHA } from "../src/settings/index.ts";
import { ensurePrState } from "../src/state/intake.ts";
import { workPublishRecord } from "../src/state/publish.ts";
import { insertWorkRun } from "../src/state/workRuns.ts";
import { openSqliteAppState } from "./integration/db.ts";

vi.mock("../src/evlog.ts", () => ({
  logWarn: vi.fn(),
}));

import { logWarn } from "../src/evlog.ts";

const handles: Array<{ close: () => void }> = [];

function openTarget(workItemId = "wi-1", resourceKey = "o/r#1") {
  const handle = openSqliteAppState();
  handles.push(handle);
  ensurePrState(handle.db, resourceKey, 1_000);
  insertWorkRun(handle.db, {
    workId: workItemId,
    prKey: resourceKey,
    kind: "review",
    laneEpoch: 0,
    payloadJson: "{}",
    now: 1_000,
  });
  handle.db.prepare(`UPDATE work_runs SET status = 'running' WHERE work_id = ?`).run(workItemId);
  return { db: handle.db, workItemId, resourceKey };
}

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

describe("review verdict pure rules", () => {
  it("uses a fixed check run name", () => {
    expect(reviewCheckRunName()).toBe("PR Agent Review");
  });

  it("maps a published finding check to its conclusion, status, and summary", () => {
    expect(
      ownVerdictSurfaces({ kind: "published", conclusion: "failure", blockingCount: 2 }),
    ).toEqual({ checkRun: "failure", commitStatus: "failure", summary: "2 findings" });
    expect(
      ownVerdictSurfaces({ kind: "published", conclusion: "success", blockingCount: 0 }),
    ).toEqual({ checkRun: "success", commitStatus: "success", summary: "No findings" });
    expect(
      ownVerdictSurfaces({ kind: "published", conclusion: "neutral", blockingCount: 0 }),
    ).toEqual({
      checkRun: "neutral",
      commitStatus: "error",
      summary: FINDING_INVENTORY_UNAVAILABLE_NOTE,
    });
    expect(
      ownVerdictSurfaces({
        kind: "published",
        conclusion: "success",
        blockingCount: 0,
        summary: "Documentation-only change set.",
      }).summary,
    ).toBe("Documentation-only change set.");
  });

  it("maps each own-verdict outcome to one check conclusion and commit status", () => {
    expect(ownVerdictSurfaces({ kind: "partial", note: "Coverage partial." })).toEqual({
      checkRun: "neutral",
      commitStatus: "error",
      summary: "Coverage partial.",
    });
    expect(ownVerdictSurfaces({ kind: "cancelled" })).toEqual({
      checkRun: "cancelled",
      commitStatus: "error",
      summary: REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
    });
    expect(ownVerdictSurfaces({ kind: "superseded" }).checkRun).toBe("cancelled");
    expect(ownVerdictSurfaces({ kind: "stale_head" }).checkRun).toBe("cancelled");
    expect(ownVerdictSurfaces({ kind: "crashed" })).toEqual({
      checkRun: "action_required",
      commitStatus: "error",
      summary: "PR Agent could not complete the review after retries.",
    });
    expect(ownVerdictSurfaces({ kind: "not_published" }).checkRun).toBe("action_required");
  });

  it("replays a stored summary verdict without guessing unpublished", () => {
    expect(ownVerdictFromSummaryDetail(null)).toEqual({ kind: "not_published" });
    expect(
      ownVerdictFromSummaryDetail({
        ownVerdictKind: "partial",
        ownVerdictNote: "Security specialist failed.",
      }),
    ).toEqual({ kind: "partial", note: "Security specialist failed." });
    expect(ownVerdictFromSummaryDetail({ ownCheckFailing: true })).toEqual({
      kind: "published",
      conclusion: "failure",
      blockingCount: 1,
    });
    expect(
      ownVerdictFromSummaryDetail({
        ownVerdictKind: "partial",
        ownPartialReason: "unread",
        ownCheckFailing: true,
        ownVerdictNote: "Unread changed files: src/a.ts.",
      }),
    ).toEqual({ kind: "published", conclusion: "failure", blockingCount: 1 });
    expect(ownVerdictFromSummaryDetail({ ownVerdictKind: "published" })).toEqual({
      kind: "published",
      conclusion: "success",
      blockingCount: 0,
    });
    expect(
      ownVerdictFromSummaryDetail(
        summaryCommentVerdictMeta({
          kind: "published",
          conclusion: "neutral",
          checkFailSeverity: "P2",
        }),
      ),
    ).toEqual({ kind: "published", conclusion: "neutral", blockingCount: 0 });
    expect(
      summaryCommentVerdictMeta({
        kind: "published",
        conclusion: "failure",
        checkFailSeverity: "P2",
      }),
    ).toEqual({
      ownVerdictKind: "published",
      ownCheckFailing: true,
      ownCheckFailSeverity: "P2",
    });
    expect(
      summaryCommentVerdictMeta({
        kind: "published",
        conclusion: "neutral",
        checkFailSeverity: "P1",
      }),
    ).toEqual({
      ownVerdictKind: "published",
      ownCheckFailing: false,
      ownCheckIncomplete: true,
      ownCheckFailSeverity: "P1",
    });
  });

  it("promotes a failing check under partial coverage and keeps a passing check partial", () => {
    const unjudged = {
      kind: "partial" as const,
      unjudged: ["tests"] as const,
      note: "Not judged: tests.",
    };
    expect(closeOutcomeForCoverage(unjudged, { conclusion: "failure", blockingCount: 2 })).toEqual({
      kind: "published",
      conclusion: "failure",
      blockingCount: 2,
    });
    expect(closeOutcomeForCoverage(unjudged, { conclusion: "success", blockingCount: 0 })).toEqual({
      kind: "partial",
      note: unjudged.note,
    });
    const specialistsAndUnread = {
      kind: "partial" as const,
      failed: ["security"] as const,
      paths: ["src/a.ts"],
      note: "Coverage partial: security specialist failed. Unread changed files: src/a.ts.",
    };
    expect(
      closeOutcomeForCoverage(specialistsAndUnread, { conclusion: "success", blockingCount: 0 }),
    ).toEqual({ kind: "partial", note: specialistsAndUnread.note });
    expect(
      closeOutcomeForCoverage(specialistsAndUnread, { conclusion: "failure", blockingCount: 2 }),
    ).toEqual({
      kind: "published",
      conclusion: "failure",
      blockingCount: 2,
    });
    expect(
      ownVerdictFromSummaryDetail({
        ownVerdictKind: "partial",
        ownPartialReason: "unjudged",
        ownCheckFailing: true,
        ownBlockingCount: 2,
      }),
    ).toEqual({ kind: "published", conclusion: "failure", blockingCount: 2 });
    expect(
      ownVerdictFromSummaryDetail({
        ownVerdictKind: "partial",
        ownPartialReason: "specialists",
        ownCheckFailing: true,
        ownVerdictNote: "Coverage partial: security specialist failed.",
      }),
    ).toEqual({ kind: "published", conclusion: "failure", blockingCount: 1 });
    expect(
      ownVerdictFromSummaryDetail({
        ownVerdictKind: "partial",
        ownPartialReason: "mystery",
        ownCheckFailing: true,
      }),
    ).toEqual({ kind: "partial", note: "Partial specialist coverage." });
  });

  it("publishes failure when unread files coincide with a failing check", () => {
    const unread = {
      kind: "partial" as const,
      paths: ["src/a.ts"],
      note: "Unread changed files: src/a.ts.",
    };
    expect(closeOutcomeForCoverage(unread, { conclusion: "failure", blockingCount: 4 })).toEqual({
      kind: "published",
      conclusion: "failure",
      blockingCount: 4,
    });
    expect(closeOutcomeForCoverage(unread, { conclusion: "success", blockingCount: 0 })).toEqual({
      kind: "partial",
      note: unread.note,
    });
  });

  it("maps the close outcome onto a GitHub review event without using findingCheck alone", () => {
    expect(
      githubReviewEventFromCloseOutcome({
        kind: "published",
        conclusion: "failure",
        blockingCount: 1,
      }),
    ).toBe("REQUEST_CHANGES");
    expect(
      githubReviewEventFromCloseOutcome({
        kind: "published",
        conclusion: "success",
        blockingCount: 0,
      }),
    ).toBe("APPROVE");
    expect(
      githubReviewEventFromCloseOutcome({
        kind: "published",
        conclusion: "neutral",
        blockingCount: 0,
      }),
    ).toBe("COMMENT");
    const unreadSuccess = closeOutcomeForCoverage(
      { kind: "partial", paths: ["src/a.ts"], note: "Unread changed files: src/a.ts." },
      { conclusion: "success", blockingCount: 0 },
    );
    expect(githubReviewEventFromCloseOutcome(unreadSuccess)).toBe("COMMENT");
    expect(githubReviewEventFromCloseOutcome({ kind: "cancelled" })).toBeUndefined();
    expect(githubReviewEventFromCloseOutcome({ kind: "superseded" })).toBeUndefined();
    expect(githubReviewEventFromCloseOutcome({ kind: "stale_head" })).toBeUndefined();
    expect(githubReviewEventFromCloseOutcome({ kind: "crashed" })).toBeUndefined();
    expect(githubReviewEventFromCloseOutcome({ kind: "not_published" })).toBeUndefined();
  });
});

describe("reviewVerdictSurfaces (SQLite)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates, records, and completes a check run idempotently", async () => {
    const target = openTarget();
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const startSpy = vi.spyOn(surface, "startReviewCheck");
    const finishSpy = vi.spyOn(surface, "finishReviewCheck");

    const verdict = reviewVerdictSurfaces({
      target,
      prSurface: surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      reviewLens: "review",
      headSha: "sha1",
      commitStatusEnabled: false,
      summaryCommentId: 77,
    });

    const firstId = await verdict.pending();
    const secondId = await verdict.pending();
    expect(firstId).toBeGreaterThan(0);
    expect(secondId).toBe(firstId);
    expect(startSpy).toHaveBeenCalledTimes(1);

    await verdict.close({ kind: "published", conclusion: "failure", blockingCount: 2 });
    expect(finishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: firstId,
        conclusion: "failure",
        summary: "2 findings",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-77",
      }),
    );
    expect(workPublishRecord(target.db, "wi-1", "check_run")?.detail.conclusion).toBe("failure");
  });

  it("retains the first selected verdict when close is called again with a different outcome", async () => {
    const target = openTarget();
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const verdict = reviewVerdictSurfaces({
      target,
      prSurface: surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      reviewLens: "review",
      headSha: "sha1",
      commitStatusEnabled: true,
    });

    const first = await verdict.close({
      kind: "published",
      conclusion: "failure",
      blockingCount: 1,
    });
    const second = await verdict.close({ kind: "cancelled" });
    expect(first.conclusion).toBe("failure");
    expect(second.conclusion).toBe("failure");
  });

  it("starts a pending commit status independently when Checks are denied", async () => {
    const target = openTarget();
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    const obs = availableInstallationCapabilities({
      appId: 1,
      installationId: 42,
      owner: "o",
      repo: "r",
    });
    Object.assign(surface, {
      capabilities: createReviewCapabilityPolicy({
        ...obs,
        availability: { ...obs.availability, checksWrite: "denied" },
      }),
    });
    const startCheck = vi.spyOn(surface, "startReviewCheck");
    const setStatus = vi.spyOn(surface, "setReviewCommitStatus");

    const verdict = reviewVerdictSurfaces({
      target,
      prSurface: surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      reviewLens: "review",
      headSha: "sha1",
      commitStatusEnabled: true,
    });
    await expect(verdict.pending()).resolves.toBeNull();
    expect(startCheck).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("sha1", expect.objectContaining({ state: "pending" }));
  });

  it("skips commit status for empty or deferred head SHA and logs check failures without throwing", async () => {
    const target = openTarget();
    const { surface } = createFakePrSurface({ owner: "o", repo: "r", prNumber: 1 });
    vi.spyOn(surface, "startReviewCheck").mockRejectedValueOnce(
      Object.assign(new Error("check API down"), { status: 403 }),
    );
    const setStatus = vi.spyOn(surface, "setReviewCommitStatus");

    const verdict = reviewVerdictSurfaces({
      target,
      prSurface: surface,
      owner: "o",
      repo: "r",
      prNumber: 1,
      reviewLens: "review",
      headSha: DEFERRED_HEAD_SHA,
      commitStatusEnabled: true,
    });
    await expect(verdict.pending()).resolves.toBeNull();
    expect(setStatus).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "review_check_run_start_failed",
      expect.objectContaining({ message: "check API down" }),
    );
  });
});
