import {
  extractVerificationFailureBlock,
  injectVerificationFailureIntoCiCell,
  preserveVerificationFailureBlock,
} from "../../agent/verification/verificationFailureSignal.js";
import {
  escapeTableHtml,
  escapeTablePlainCell,
  renderTableEm,
  renderTableLink,
} from "../../github/markdownFormat.js";
import { parseReviewMetaFromCommentBody } from "./reviewMetaParse.js";
import type { CiFailureDetail, CiSummary } from "./ciSummaryTypes.js";

/** HTML comment markers for surgical CI-cell refresh (ADR 0018). */
export const CI_SUMMARY_CELL_START = "<!-- pr-agent:ci-summary -->";
export const CI_SUMMARY_CELL_END = "<!-- /pr-agent:ci-summary -->";

const CI_SUMMARY_CELL_RE =
  /<!--\s*pr-agent:ci-summary(?:\s+head=([^\s]+))?\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*-->/;

export function parseCiSummaryMarkerHead(body: string): string | null {
  return CI_SUMMARY_CELL_RE.exec(body)?.[1] ?? null;
}

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
export function renderCiSummaryCell(summary: CiSummary, headSha?: string): string {
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
  const start =
    headSha == null || headSha.length === 0
      ? CI_SUMMARY_CELL_START
      : `<!-- pr-agent:ci-summary head=${headSha} -->`;
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

/**
 * Replaces the marked CI cell inside an existing summary comment body.
 * Returns null when markers are missing (cannot surgically patch).
 */
export function patchCiSummaryCellInCommentBody(
  body: string,
  summary: CiSummary,
  headSha?: string,
): string | null {
  if (!CI_SUMMARY_CELL_RE.test(body)) return null;
  const failure = extractVerificationFailureBlock(body);
  let nextCell = renderCiSummaryCell(summary, headSha);
  if (failure != null) nextCell = injectVerificationFailureIntoCiCell(nextCell, failure);
  return body.replace(CI_SUMMARY_CELL_RE, nextCell);
}

export function commentBodyHasCiSummaryCell(body: string): boolean {
  return CI_SUMMARY_CELL_RE.test(body);
}

const CI_SUMMARY_TABLE_ROW_RE =
  /<tr><td><strong>CI<\/strong><\/td><td><!--\s*pr-agent:ci-summary(?:\s+head=[^\s]+)?\s*-->[\s\S]*?<!--\s*\/pr-agent:ci-summary\s*--><\/td><\/tr>/;

const SOURCE_TABLE_ROW_RE = /<tr><td><strong>Source<\/strong><\/td><td>[\s\S]*?<\/td><\/tr>/;

/**
 * Keeps the prior CI gate row when a progress tick rewrites the stub without a
 * fresh CI summary (ack posted it; specialist ticks should not drop it).
 * Drops the prior row when its marker head is absent or differs from the next
 * body review-meta head, so an old red summary never freezes onto a new head.
 */
export function preserveCiSummaryRowInCommentBody(previousBody: string, nextBody: string): string {
  const nextWithFailure = preserveVerificationFailureBlock(previousBody, nextBody);
  if (commentBodyHasCiSummaryCell(nextWithFailure)) return nextWithFailure;
  const nextHead = parseReviewMetaFromCommentBody(nextBody)?.headSha;
  if (nextHead != null && parseCiSummaryMarkerHead(previousBody) !== nextHead) {
    return nextWithFailure;
  }
  const ciRow = CI_SUMMARY_TABLE_ROW_RE.exec(previousBody)?.[0];
  if (ciRow == null) return nextWithFailure;
  if (!SOURCE_TABLE_ROW_RE.test(nextWithFailure)) return nextWithFailure;
  return nextWithFailure.replace(SOURCE_TABLE_ROW_RE, (sourceRow) => `${sourceRow}\n${ciRow}`);
}
