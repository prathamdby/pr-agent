import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import {
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
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
  const token = params.setup.getToken();
  const tokenExpiresAtTs = params.setup.getTokenExpiresAtTs();
  const sentinel = reviewSummarySentinelForMode(params.reviewMode);
  try {
    const existing = await resolveVerifiedSummaryCommentRef(
      token,
      params.owner,
      params.repo,
      params.prNumber,
      sentinel,
      undefined,
      tokenExpiresAtTs,
    );
    if (existing) return;

    await upsertReviewSummaryComment(
      token,
      params.owner,
      params.repo,
      params.prNumber,
      renderReviewFailureNotice({ mode: params.reviewMode, retryCommand }),
      sentinel,
      undefined,
      tokenExpiresAtTs,
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
