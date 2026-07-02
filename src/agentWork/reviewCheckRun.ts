import type { Pool } from "pg";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import { httpStatus } from "../github/httpStatus.js";
import {
  createReviewCheckRun,
  updateReviewCheckRun,
  type ReviewCheckRunConclusion,
} from "../github/reviewPublish.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import { REVIEW_CHECK_RUN_RESERVATION_STALE_MS } from "../settings/index.js";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
} from "./repository.js";

type CheckRunConfig = Pick<Config, "enableReviewCheckRun">;

function isMissingChecksPermissionError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== 403 && status !== 404) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Resource not accessible by integration") ||
    message.includes("Not Found") ||
    status === 404
  );
}

function logCheckRunWarning(
  event: string,
  error: unknown,
  fields: Record<string, string | number | undefined>,
): void {
  if (isMissingChecksPermissionError(error)) return;
  logWarn(event, {
    ...fields,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function reviewCheckRunName(mode: ReviewMode): string {
  switch (mode) {
    case "review-security":
      return "PR Agent Security Review";
    case "review-quality":
      return "PR Agent Quality Review";
    case "review-tests":
      return "PR Agent Tests Review";
    case "review":
      return "PR Agent Review";
  }
  const exhaustive: never = mode;
  return exhaustive;
}

export function reviewCheckDetailsUrl(
  owner: string,
  repo: string,
  prNumber: number,
  summaryCommentId?: string | number | null,
): string | undefined {
  if (summaryCommentId == null) return undefined;
  return `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`;
}

export async function ensureReviewCheckRunStarted(
  pool: Pool,
  params: {
    cfg: CheckRunConfig;
    token: string;
    tokenExpiresAtTs?: number;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    workItemId: string;
    resourceKey: string;
    reviewLens: ReviewMode;
  },
): Promise<number | null> {
  if (!params.cfg.enableReviewCheckRun) return null;
  const existing = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  if (existing != null) return existing;

  const name = reviewCheckRunName(params.reviewLens);
  let reserved = await reserveReviewCheckRun(pool, {
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    detail: {
      status: "starting",
      headSha: params.headSha,
      name,
    },
  });
  if (!reserved) {
    const existingAfterReserve = await getReviewCheckRunGithubId(
      pool,
      params.workItemId,
      params.reviewLens,
    );
    if (existingAfterReserve != null) return existingAfterReserve;

    const released = await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      staleBefore: new Date(Date.now() - REVIEW_CHECK_RUN_RESERVATION_STALE_MS),
    });
    if (!released) {
      return getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
    }

    reserved = await reserveReviewCheckRun(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      detail: {
        status: "starting",
        headSha: params.headSha,
        name,
        recoveredStaleReservation: true,
      },
    });
    if (!reserved) {
      return getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
    }
  }

  let check: { id: number; url: string | null };
  try {
    check = await createReviewCheckRun(
      params.token,
      params.owner,
      params.repo,
      {
        name,
        headSha: params.headSha,
        externalId: params.workItemId,
        summary: "PR Agent review is in progress.",
      },
      params.tokenExpiresAtTs,
    );
  } catch (e) {
    await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
    });
    logCheckRunWarning("review_check_run_start_failed", e, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
    });
    return null;
  }

  try {
    await recordReviewCheckRun(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      githubId: check.id,
      detail: {
        status: "in_progress",
        headSha: params.headSha,
        name,
        htmlUrl: check.url,
      },
    });
  } catch (e) {
    try {
      await updateReviewCheckRun(
        params.token,
        params.owner,
        params.repo,
        check.id,
        {
          name,
          conclusion: "cancelled",
          completedAt: new Date().toISOString(),
          summary: "PR Agent could not persist this check run.",
        },
        params.tokenExpiresAtTs,
      );
    } catch (cancelError) {
      logCheckRunWarning("review_check_run_orphan_cancel_failed", cancelError, {
        owner: params.owner,
        repo: params.repo,
        pr: params.prNumber,
        reviewLens: params.reviewLens,
        checkRunId: check.id,
      });
    }
    await releaseUnstartedReviewCheckRunReservation(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
    });
    logWarn("review_check_run_record_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId: check.id,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  return check.id;
}

export async function completeReviewCheckRun(
  pool: Pool,
  params: {
    cfg: CheckRunConfig;
    token: string;
    tokenExpiresAtTs?: number;
    owner: string;
    repo: string;
    prNumber: number;
    workItemId: string;
    resourceKey: string;
    reviewLens: ReviewMode;
    conclusion: ReviewCheckRunConclusion;
    summary: string;
    detailsUrl?: string;
  },
): Promise<boolean> {
  if (!params.cfg.enableReviewCheckRun) return false;
  const checkRunId = await getReviewCheckRunGithubId(pool, params.workItemId, params.reviewLens);
  if (checkRunId == null) return false;

  const completedAt = new Date().toISOString();
  const name = reviewCheckRunName(params.reviewLens);
  try {
    await updateReviewCheckRun(
      params.token,
      params.owner,
      params.repo,
      checkRunId,
      {
        name,
        conclusion: params.conclusion,
        completedAt,
        summary: params.summary,
        detailsUrl: params.detailsUrl,
      },
      params.tokenExpiresAtTs,
    );
  } catch (e) {
    logCheckRunWarning("review_check_run_complete_failed", e, {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: params.conclusion,
    });
    return false;
  }

  try {
    await recordReviewCheckRun(pool, {
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      githubId: checkRunId,
      detail: {
        status: "completed",
        conclusion: params.conclusion,
        completedAt,
        detailsUrl: params.detailsUrl,
      },
    });
  } catch (e) {
    logWarn("review_check_run_complete_record_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: params.conclusion,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return true;
}
