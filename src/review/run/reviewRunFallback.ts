import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../reviewSchema.js";
import { MAX_REVIEW_PUBLISH_CALLS } from "../../settings/index.js";
import { refreshInstallationTokenIfNearExpiry } from "../orchestrator/refreshInstallationTokenIfNearExpiry.js";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs?: () => number;
  readonly refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  readonly refreshNearExpiry?: () => Promise<void>;
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
    await refreshInstallationTokenIfNearExpiry({
      getTokenExpiresAtTs: params.getTokenExpiresAtTs,
      refreshInstallationToken: params.refreshInstallationToken,
      refreshNearExpiry: params.refreshNearExpiry,
    });
    const token = params.getToken();
    const tokenExpiresAtTs = params.getTokenExpiresAtTs?.();
    const sentinel = reviewSummarySentinelForMode(params.reviewMode);
    await upsertReviewSummaryComment(
      token,
      params.owner,
      params.repo,
      params.prNumber,
      renderReviewFailureNotice({ mode: params.reviewMode, retryCommand: "/review" }),
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
