import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import type { ReviewRunSetup } from "./reviewRunSetup.js";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { MAX_REVIEW_PUBLISH_CALLS } from "../../settings/index.js";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly setup: ReviewRunSetup;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewMode: AnyReviewLens;
  readonly publishAttempts: number;
}): Promise<void> {
  logWarn("agent_publish_fallback", {
    mode: params.reviewMode,
    publishAttempts: params.publishAttempts,
    maxPublishCalls: MAX_REVIEW_PUBLISH_CALLS,
  });
  const token = params.setup.getToken();
  const tokenExpiresAtTs = params.setup.getTokenExpiresAtTs();
  const sentinel = REVIEW_SUMMARY_SENTINEL;
  try {
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
