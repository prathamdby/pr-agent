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
} from "../../settings/index.js";
import { reviewSummarySentinelForMode } from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { WorkSource } from "../reviewSchema.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { renderCiSummaryCell, shouldRenderCiSummaryRow } from "../ci/renderCiSummary.js";

export function renderReviewProgressComment(params: {
  mode: AnyReviewLens;
  headSha: string;
  source: WorkSource;
  ciSummary?: CiSummary | null;
}): string {
  const sourceLabel =
    params.source === "auto" ? REVIEW_PROGRESS_SOURCE_AUTO : REVIEW_PROGRESS_SOURCE_SLASH;
  const tableRows: Array<[string, string]> = [
    [renderTableStrong("Head"), renderTableCode(params.headSha)],
    [renderTableStrong("Source"), escapeTableHtml(sourceLabel)],
  ];
  if (shouldRenderCiSummaryRow(params.ciSummary)) {
    tableRows.push([renderTableStrong("CI"), renderCiSummaryCell(params.ciSummary)]);
  }
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_PROGRESS_NOTE),
    "",
    renderKeyValueTable(tableRows),
  ].join("\n");
}

export function renderReviewFailureNotice(params: {
  mode: AnyReviewLens;
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
