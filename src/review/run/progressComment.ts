import {
  escapeTableHtml,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableCode,
  renderTableStrong,
} from "../../github/markdownFormat.js";
import {
  REVIEW_FAILURE_ALERT,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_SOURCE_AUTO,
  REVIEW_PROGRESS_SOURCE_SLASH,
  REVIEW_SUMMARY_SENTINEL,
} from "../../settings/index.js";
import type { WorkSource } from "../reviewSchema.js";

export function renderReviewProgressComment(params: {
  headSha: string;
  source: WorkSource;
}): string {
  const sourceLabel =
    params.source === "auto" ? REVIEW_PROGRESS_SOURCE_AUTO : REVIEW_PROGRESS_SOURCE_SLASH;
  return [
    REVIEW_SUMMARY_SENTINEL,
    "",
    renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_PROGRESS_NOTE),
    "",
    renderKeyValueTable([
      [renderTableStrong("Head"), renderTableCode(params.headSha)],
      [renderTableStrong("Source"), escapeTableHtml(sourceLabel)],
    ]),
  ].join("\n");
}

export function renderReviewFailureNotice(params: { retryCommand: string }): string {
  return [
    REVIEW_SUMMARY_SENTINEL,
    "",
    renderGitHubAlert(
      REVIEW_FAILURE_ALERT,
      `Review did not finish. Run \`${params.retryCommand}\` to try again.`,
    ),
  ].join("\n");
}
