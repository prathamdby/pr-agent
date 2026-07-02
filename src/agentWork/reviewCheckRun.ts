import type { Pool } from "pg";
import type { Config } from "../config.js";
import { logWarn } from "../evlog.js";
import {
  createReviewCheckRun,
  updateReviewCheckRun,
  type ReviewCheckRunConclusion,
} from "../github/reviewPublish.js";
import type { ReviewMode } from "../review/reviewSchema.js";
import {
  getReviewCheckRunGithubId,
  recordReviewCheckRun,
  releaseUnstartedReviewCheckRunReservation,
  reserveReviewCheckRun,
} from "./repository.js";

type CheckRunConfig = Pick<Config, "enableReviewCheckRun">;

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
  const existing = await getReviewCheckRunGithubId(
    pool,
    params.workItemId,
    params.resourceKey,
    params.reviewLens,
  );
  if (existing != null) return existing;

  const name = reviewCheckRunName(params.reviewLens);
  const reserved = await reserveReviewCheckRun(pool, {
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
    return getReviewCheckRunGithubId(
      pool,
      params.workItemId,
      params.resourceKey,
      params.reviewLens,
    );
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
    logWarn("review_check_run_start_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

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
  const checkRunId = await getReviewCheckRunGithubId(
    pool,
    params.workItemId,
    params.resourceKey,
    params.reviewLens,
  );
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
    return true;
  } catch (e) {
    logWarn("review_check_run_complete_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      reviewLens: params.reviewLens,
      checkRunId,
      conclusion: params.conclusion,
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
