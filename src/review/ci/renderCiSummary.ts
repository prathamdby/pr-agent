import {
  escapeTableHtml,
  escapeTablePlainCell,
  renderTableEm,
  renderTableLink,
} from "../../github/markdownFormat.js";
import type { CiFailureDetail, CiSummary } from "./ciSummaryTypes.js";

/** HTML comment markers for surgical CI-cell refresh (ADR 0018). */
export const CI_SUMMARY_CELL_START = "<!-- pr-agent:ci-summary -->";
export const CI_SUMMARY_CELL_END = "<!-- /pr-agent:ci-summary -->";

export {
  commentBodyHasCiSummaryCell,
  parseCiSummaryMarker,
  parseCiSummaryMarkerHead,
  parseCiSummaryMarkerVersion,
} from "./ciSummaryCell.js";

export type CiSummarySections = {
  readonly headline: string;
  readonly failures: readonly CiFailureDetail[];
  readonly permissionNote?: string;
};

/** Shared field selection for the CI table cell and agent-fix plain-text digest. */
export function selectCiSummarySections(summary: CiSummary): CiSummarySections {
  const failures =
    summary.status === "failing" && summary.failures.length > 0 ? [...summary.failures] : [];
  const permissionNote = summary.permissionNote?.trim();
  return {
    headline: summary.headline,
    failures,
    ...(permissionNote != null && permissionNote.length > 0 ? { permissionNote } : {}),
  };
}

/**
 * Plain-text CI digest for the agent fix prompt.
 * Same section selection as the table cell; includes failure URL when present.
 */
export function formatCiSummaryPlainText(summary: CiSummary): string {
  const sections = selectCiSummarySections(summary);
  const parts: string[] = [sections.headline];
  for (const failure of sections.failures) {
    const lines = [failure.name];
    if (failure.url != null && failure.url.length > 0) {
      lines.push(failure.url);
    }
    lines.push(failure.reason, failure.fixHint);
    parts.push(lines.join("\n"));
  }
  if (sections.permissionNote != null) {
    parts.push(sections.permissionNote);
  }
  return parts.join("\n\n");
}

/** Renders the CI gate cell for the review summary / progress stub table. */
export function renderCiSummaryCell(
  summary: CiSummary,
  headSha?: string,
  version?: number,
): string {
  const sections = selectCiSummarySections(summary);
  const parts: string[] = [escapeTablePlainCell(sections.headline)];
  for (const failure of sections.failures) {
    const nameHtml =
      failure.url != null
        ? renderTableLink(failure.name, failure.url)
        : `<strong>${escapeTableHtml(failure.name)}</strong>`;
    parts.push(
      `${nameHtml}<br>${escapeTablePlainCell(failure.reason)}<br>${renderTableEm(failure.fixHint)}`,
    );
  }
  if (sections.permissionNote != null) {
    parts.push(renderTableEm(sections.permissionNote));
  }
  const inner = parts.join("<br><br>");
  let start = CI_SUMMARY_CELL_START;
  if (headSha != null && headSha.length > 0) {
    start =
      version != null
        ? `<!-- pr-agent:ci-summary head=${headSha} v=${version} -->`
        : `<!-- pr-agent:ci-summary head=${headSha} -->`;
  }
  return `${start}${inner}${CI_SUMMARY_CELL_END}`;
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
