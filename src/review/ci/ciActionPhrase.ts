import type { CiSummary } from "./ciSummaryTypes.js";
import { renderCiActionPhrase } from "./ciSummaryCell.js";

export function formatReviewActionLineCiStatus(summary: CiSummary | null | undefined): string {
  switch (summary?.status) {
    case "passing":
      return "CI is passing";
    case "failing":
      return "CI is failing";
    case "pending":
      return "CI is pending";
    case "unavailable":
      return "CI is unavailable";
    case "none":
      return "No CI checks ran on this head";
    default:
      return "CI has not started";
  }
}

export function renderReviewActionLineCiStatus(summary: CiSummary | null | undefined): string {
  return renderCiActionPhrase(formatReviewActionLineCiStatus(summary));
}
