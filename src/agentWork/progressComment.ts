import { renderGitHubAlert } from "../github/markdownFormat.js";
import { reviewSummarySentinelForMode, type ReviewMode } from "../agent/reviewSchema.js";
import {
  REVIEW_FAILURE_ALERT,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_SOURCE_AUTO,
  REVIEW_PROGRESS_SOURCE_SLASH,
} from "../settings/index.js";

export function renderReviewProgressComment(params: {
  mode: ReviewMode;
  headSha: string;
  source: "auto" | "slash";
}): string {
  const sourceLabel =
    params.source === "auto" ? REVIEW_PROGRESS_SOURCE_AUTO : REVIEW_PROGRESS_SOURCE_SLASH;
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_PROGRESS_NOTE),
    "",
    "| | |",
    "| --- | --- |",
    `| **Head** | \`${params.headSha}\` |`,
    `| **Source** | ${sourceLabel} |`,
  ].join("\n");
}

export function renderReviewFailureNotice(params: {
  mode: ReviewMode;
  retryCommand: string;
}): string {
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    renderGitHubAlert(
      REVIEW_FAILURE_ALERT,
      `Review did not finish. Run \`${params.retryCommand}\` to try again.`,
    ),
  ].join("\n");
}

/** @deprecated Use renderReviewFailureNotice — kept for callers migrating off structured publish wording. */
export function renderStructuredPublishFallback(params: { mode: ReviewMode }): string {
  const retryCommand = params.mode === "review-security" ? "/review-security" : "/review";
  return renderReviewFailureNotice({ mode: params.mode, retryCommand });
}
