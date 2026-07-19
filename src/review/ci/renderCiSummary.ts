import {
  escapeTableHtml,
  escapeTablePlainCell,
  renderTableEm,
  renderTableLink,
} from "../../github/markdownFormat.js";
import type { CiSummary } from "./ciSummaryTypes.js";

/** Renders the CI gate cell for the review summary / progress stub table. */
export function renderCiSummaryCell(summary: CiSummary): string {
  if (summary.status === "failing" && summary.failures.length > 0) {
    const parts: string[] = [escapeTablePlainCell(summary.headline)];
    for (const failure of summary.failures) {
      const nameHtml =
        failure.url != null
          ? renderTableLink(failure.name, failure.url)
          : `<strong>${escapeTableHtml(failure.name)}</strong>`;
      parts.push(
        `${nameHtml}<br>${escapeTablePlainCell(failure.reason)}<br>${renderTableEm(failure.fixHint)}`,
      );
    }
    return parts.join("<br><br>");
  }
  return escapeTablePlainCell(summary.headline);
}

/** Whether the CI row should appear in the summary / stub table. */
export function shouldRenderCiSummaryRow(summary: CiSummary | null | undefined): boolean {
  if (summary == null) return false;
  return (
    summary.status === "passing" || summary.status === "failing" || summary.status === "pending"
  );
}
