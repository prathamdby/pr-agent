import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../reviewSchema.js";
import { MAX_REVIEW_PUBLISH_CALLS } from "../../settings/index.js";
import type { InstallationTokenHandle } from "../../github/installationTokenHandle.js";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly token: InstallationTokenHandle;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewMode: ReviewMode;
  readonly publishAttempts: number;
  readonly publishCallCount?: number;
}): Promise<void> {
  logWarn("agent_publish_fallback", {
    mode: params.reviewMode,
    publishAttempts: params.publishAttempts,
    publishCallCount: params.publishCallCount ?? 0,
    maxPublishCalls: MAX_REVIEW_PUBLISH_CALLS,
  });
  try {
    await params.token.refreshNearExpiry();
    const sentinel = reviewSummarySentinelForMode(params.reviewMode);
    await upsertReviewSummaryComment(
      params.token.getToken(),
      params.owner,
      params.repo,
      params.prNumber,
      renderReviewFailureNotice({ mode: params.reviewMode, retryCommand: "/review" }),
      sentinel,
      undefined,
      params.token.getExpiresAtTs(),
    );
  } catch (error) {
    logWarn("review_publish_fallback_comment_failed", {
      mode: params.reviewMode,
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
