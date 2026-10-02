import type { Config, AnyReviewLens } from "../../settings/index.js";
import {
  classifiedFailureLogFields,
  type ClassifiedFailure,
} from "../../errors/classifiedFailure.js";
import { logWarn } from "../../evlog.js";
import {
  createReviewSummaryComment,
  type SummaryCommentCoordination,
} from "../publish/reviewSummaryComment.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import type { ReviewRunSetup } from "./reviewRunSetup.js";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly setup: ReviewRunSetup;
  readonly summaryCoordination?: SummaryCommentCoordination;
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
  try {
    await createReviewSummaryComment({
      prSurface: params.setup.prSurface,
      reviewLens: params.reviewMode,
      coordination: params.summaryCoordination,
    }).conclude({
      body: renderReviewFailureNotice({ mode: params.reviewMode, retryCommand: "/review" }),
    });
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
