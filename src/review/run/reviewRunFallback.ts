import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import type { ReviewRunSetup } from "./reviewRunSetup.js";
import {
  reviewRetrySlashCommandForMode,
  reviewSummarySentinelForMode,
  type ReviewMode,
} from "../reviewSchema.js";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly setup: ReviewRunSetup;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewMode: ReviewMode;
  readonly publishAttempts: number;
}): Promise<void> {
  logWarn("agent_publish_fallback", {
    mode: params.reviewMode,
    publishAttempts: params.publishAttempts,
    publishCallCount: params.setup.submitState.publishCallCount,
    maxPublishCalls: params.cfg.maxReviewPublishCalls,
  });
  const retryCommand = reviewRetrySlashCommandForMode(params.reviewMode);
  try {
    await upsertReviewSummaryComment(
      params.setup.getToken(),
      params.owner,
      params.repo,
      params.prNumber,
      renderReviewFailureNotice({ mode: params.reviewMode, retryCommand }),
      reviewSummarySentinelForMode(params.reviewMode),
      undefined,
      params.setup.getTokenExpiresAtTs(),
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
