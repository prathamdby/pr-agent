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
import { SPECIALIST_IDS, type SpecialistId } from "../orchestrator/orchestratorTypes.js";
import { renderStaleReviewMetadataComment } from "./reviewRender.js";

const PROGRESS_REVISION_RE =
  /<!--\s*pr-agent:progress-revision(?:\s+workItemId=([^\s]+)\s+value=|\s+)(\d+)\s*-->/;

type SpecialistPhase =
  | { readonly phase: "running" }
  | { readonly phase: "done"; readonly threadsPublished: number }
  | { readonly phase: "no_findings" }
  | { readonly phase: "failed" };

export type SpecialistTickState =
  | {
      readonly kind: "specialists";
      readonly specialists: Readonly<Record<SpecialistId, SpecialistPhase>>;
    }
  | {
      readonly kind: "terminal";
      readonly reason: "superseded" | "stale_head";
    };

const SPECIALIST_LABELS: Record<SpecialistId, string> = {
  correctness: "Correctness",
  security: "Security",
  quality: "Quality",
  tests: "Tests",
};

function renderSpecialistPhase(state: SpecialistPhase): string {
  switch (state.phase) {
    case "running":
      return "⏳ running";
    case "done":
      return `✅ ${state.threadsPublished} ${state.threadsPublished === 1 ? "thread" : "threads"}`;
    case "no_findings":
      return "⚪ no findings";
    case "failed":
      return "⚠️ failed (coverage partial)";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function renderTerminalProgress(source: WorkSource): string {
  return source === "slash"
    ? "Superseded. Rescheduled for new head."
    : "Superseded by a newer pull request update.";
}

export function renderProgressRevisionComment(revision: number, workItemId?: string): string {
  return workItemId == null
    ? `<!-- pr-agent:progress-revision ${revision} -->`
    : `<!-- pr-agent:progress-revision workItemId=${encodeURIComponent(workItemId)} value=${revision} -->`;
}

export function parseProgressRevision(body: string): number | null {
  return parseProgressRevisionState(body)?.revision ?? null;
}

export function withProgressRevisionComment(
  body: string,
  revision: number,
  workItemId?: string,
): string {
  const withoutRevision = body.replace(PROGRESS_REVISION_RE, "").trimEnd();
  return `${withoutRevision}\n${renderProgressRevisionComment(revision, workItemId)}`;
}

export function parseProgressRevisionState(
  body: string,
): { readonly revision: number; readonly workItemId?: string } | null {
  const match = PROGRESS_REVISION_RE.exec(body);
  if (!match?.[2]) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) return null;
  if (match[1] == null) return { revision };
  try {
    return { revision, workItemId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

export function renderReviewProgressComment(params: {
  mode: AnyReviewLens;
  headSha: string;
  source: WorkSource;
  ciSummary?: CiSummary | null;
  tickState?: SpecialistTickState;
  progressRevision?: number;
  progressWorkItemId?: string;
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
  if (params.tickState?.kind === "specialists") {
    for (const specialist of SPECIALIST_IDS) {
      tableRows.push([
        renderTableStrong(SPECIALIST_LABELS[specialist]),
        escapeTableHtml(renderSpecialistPhase(params.tickState.specialists[specialist])),
      ]);
    }
  }
  const progressNote =
    params.tickState?.kind === "terminal"
      ? renderTerminalProgress(params.source)
      : REVIEW_PROGRESS_NOTE;
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    renderGitHubAlert(REVIEW_OVERVIEW_ALERT, progressNote),
    "",
    renderKeyValueTable(tableRows),
    "",
    renderStaleReviewMetadataComment({
      headSha: params.headSha,
      mode: params.mode,
      stale: params.tickState?.kind === "terminal" && params.tickState.reason === "stale_head",
    }),
    renderProgressRevisionComment(params.progressRevision ?? 0, params.progressWorkItemId),
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
