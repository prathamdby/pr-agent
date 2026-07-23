import {
  escapeTableHtml,
  escapeTablePlainCell,
  renderTableEm,
  renderTableLink,
} from "../../github/markdownFormat.js";
import type { CiSummary } from "./ciSummaryTypes.js";

/** HTML comment markers for surgical CI-cell refresh (ADR 0026). */
export const CI_SUMMARY_CELL_START = "<!-- pr-agent:ci-summary -->";
export const CI_SUMMARY_CELL_END = "<!-- /pr-agent:ci-summary -->";

const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

/** Renders the CI gate cell for the review summary / progress stub table. */
export function renderCiSummaryCell(summary: CiSummary): string {
  const parts: string[] = [escapeTablePlainCell(summary.headline)];
  if (summary.status === "failing" && summary.failures.length > 0) {
    for (const failure of summary.failures) {
      const nameHtml =
        failure.url != null
          ? renderTableLink(failure.name, failure.url)
          : `<strong>${escapeTableHtml(failure.name)}</strong>`;
      parts.push(
        `${nameHtml}<br>${escapeTablePlainCell(failure.reason)}<br>${renderTableEm(failure.fixHint)}`,
      );
    }
  }
  if (summary.permissionNote != null && summary.permissionNote.trim().length > 0) {
    parts.push(renderTableEm(summary.permissionNote));
  }
  const inner = parts.join("<br><br>");
  return `${CI_SUMMARY_CELL_START}${inner}${CI_SUMMARY_CELL_END}`;
}

export type RenderableCiSummary = CiSummary & {
  readonly status: "passing" | "failing" | "pending" | "unavailable";
};

export function shouldRenderCiSummaryRow(
  summary: CiSummary | null | undefined,
): summary is RenderableCiSummary {
  if (summary == null) return false;
  return (
    summary.status === "passing" ||
    summary.status === "failing" ||
    summary.status === "pending" ||
    summary.status === "unavailable"
  );
}

/**
 * Replaces the marked CI cell inside an existing summary comment body.
 * Returns null when markers are missing (cannot surgically patch).
 */
export function patchCiSummaryCellInCommentBody(body: string, summary: CiSummary): string | null {
  if (!CI_SUMMARY_CELL_RE.test(body)) return null;
  return body.replace(CI_SUMMARY_CELL_RE, renderCiSummaryCell(summary));
}

export function commentBodyHasCiSummaryCell(body: string): boolean {
  return CI_SUMMARY_CELL_RE.test(body);
}

const CI_SUMMARY_TABLE_ROW_RE =
  /<tr><td><strong>CI<\/strong><\/td><td><!--\s*pr-agent:ci-summary\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*--><\/td><\/tr>/;

const SOURCE_TABLE_ROW_RE = /<tr><td><strong>Source<\/strong><\/td><td>[\s\S]*?<\/td><\/tr>/;

/**
 * Keeps the prior CI gate row when a progress tick rewrites the stub without a
 * fresh CI summary (ack posted it; specialist/terminal ticks should not drop it).
 */
export function preserveCiSummaryRowInCommentBody(
  previousBody: string,
  nextBody: string,
): string {
  if (commentBodyHasCiSummaryCell(nextBody)) return nextBody;
  const ciRow = CI_SUMMARY_TABLE_ROW_RE.exec(previousBody)?.[0];
  if (ciRow == null) return nextBody;
  if (!SOURCE_TABLE_ROW_RE.test(nextBody)) return nextBody;
  return nextBody.replace(SOURCE_TABLE_ROW_RE, (sourceRow) => `${sourceRow}\n${ciRow}`);
}
