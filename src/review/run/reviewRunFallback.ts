import type { Config } from "../../config.js";
import {
  classifiedFailureLogFields,
  type ClassifiedFailure,
} from "../../errors/classifiedFailure.js";
import { logWarn } from "../../evlog.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import type { ReviewRunSetup } from "./reviewRunSetup.js";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly setup: ReviewRunSetup;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewMode: AnyReviewLens;
  readonly publishAttempts: number;
  readonly lastFailure?: ClassifiedFailure;
}): Promise<void> {
  logWarn("agent_publish_fallback", {
    mode: params.reviewMode,
    publishAttempts: params.publishAttempts,
    ...(params.lastFailure != null ? classifiedFailureLogFields(params.lastFailure) : {}),
  });
  const sentinel = REVIEW_SUMMARY_SENTINEL;
  try {
    await params.setup.prSurface.upsertProgressComment(
      renderReviewFailureNotice({ mode: params.reviewMode, retryCommand: "/review" }),
      sentinel,
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
