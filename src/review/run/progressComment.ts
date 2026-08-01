import {
  escapeTableHtml,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableCode,
  renderTableStrong,
} from "../../github/markdownFormat.js";
import {
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_NO_FINDINGS,
  STATUS_RUNNING,
  STATUS_WAITING,
  statusFindings,
} from "../../github/statusCopy.js";
import {
  REVIEW_FAILURE_ALERT,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_QUEUE_LABEL,
  REVIEW_PROGRESS_QUEUED_NOTE,
  REVIEW_PROGRESS_SOURCE_AUTO,
  REVIEW_PROGRESS_SOURCE_SLASH,
} from "../../settings/index.js";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { WorkSource } from "../reviewSchema.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { renderCiSummaryCell, shouldRenderCiSummaryRow } from "../ci/renderCiSummary.js";
import {
  SPECIALIST_IDS,
  type ReconRunPhase,
  type SpecialistId,
  type SpecialistRunPhase,
} from "../orchestrator/orchestratorTypes.js";
import { renderStaleReviewMetadataComment } from "./reviewRender.js";

const PROGRESS_REVISION_RE =
  /<!--\s*pr-agent:progress-revision(?:\s+workItemId=([^\s]+)\s+value=|\s+)(\d+)\s*-->/;

type SpecialistPhase = SpecialistRunPhase;

type ReconPhase = ReconRunPhase;

type ProgressRoster = {
  readonly recon: ReconPhase;
  readonly specialists: Readonly<Record<SpecialistId, SpecialistPhase>>;
};

export type SpecialistTickState =
  | ({
      readonly kind: "specialists";
    } & ProgressRoster)
  | ({
      readonly kind: "terminal";
      readonly reason: "superseded" | "stale_head";
    } & ProgressRoster);

const SPECIALIST_LABELS: Record<SpecialistId, string> = {
  correctness: "Correctness",
  security: "Security",
  quality: "Quality",
  tests: "Tests",
};

function renderReconPhase(phase: ReconPhase): string {
  switch (phase) {
    case "running":
      return STATUS_RUNNING;
    case "done":
      return STATUS_DONE;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function renderSpecialistPhase(state: SpecialistPhase): string {
  switch (state.phase) {
    case "waiting":
      return STATUS_WAITING;
    case "running":
      return STATUS_RUNNING;
    case "done":
      return statusFindings(state.findingsAccepted);
    case "no_findings":
      return STATUS_NO_FINDINGS;
    case "failed":
      return STATUS_FAILED;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** Active roster once the review worker starts: Recon running, specialists waiting. */
export function initialProgressTickState(): Extract<SpecialistTickState, { kind: "specialists" }> {
  return {
    kind: "specialists",
    recon: "running",
    specialists: {
      correctness: { phase: "waiting" },
      security: { phase: "waiting" },
      quality: { phase: "waiting" },
      tests: { phase: "waiting" },
    },
  };
}

function renderProgressRevisionComment(revision: number, workItemId?: string): string {
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

/** Wait-queue rank for the queued progress stub (`#2 of 10`). */
export type ReviewQueuePosition = {
  readonly position: number;
  readonly total: number;
};

export function formatReviewQueuePosition(position: ReviewQueuePosition): string {
  return `#${position.position} of ${position.total}`;
}

export function renderReviewProgressComment(params: {
  mode: AnyReviewLens;
  headSha: string;
  source: WorkSource;
  ciSummary?: CiSummary | null;
  /**
   * When omitted, the stub is in the queued presentation: Head/Source/(Queue)/(CI) only,
   * no Recon or specialist rows, and a queued note (not “in progress”).
   */
  tickState?: SpecialistTickState;
  /** Shown only on the queued stub (no tickState) when lookup succeeded. */
  queuePosition?: ReviewQueuePosition | null;
  progressRevision?: number;
  progressWorkItemId?: string;
}): string {
  const sourceLabel =
    params.source === "auto" ? REVIEW_PROGRESS_SOURCE_AUTO : REVIEW_PROGRESS_SOURCE_SLASH;
  const tableRows: Array<[string, string]> = [
    [renderTableStrong("Head"), renderTableCode(params.headSha)],
    [renderTableStrong("Source"), escapeTableHtml(sourceLabel)],
  ];
  if (params.tickState == null && params.queuePosition != null) {
    tableRows.push([
      renderTableStrong(REVIEW_PROGRESS_QUEUE_LABEL),
      escapeTableHtml(formatReviewQueuePosition(params.queuePosition)),
    ]);
  }
  if (shouldRenderCiSummaryRow(params.ciSummary)) {
    tableRows.push([renderTableStrong("CI"), renderCiSummaryCell(params.ciSummary)]);
  }
  if (params.tickState != null) {
    tableRows.push([
      renderTableStrong("Recon"),
      escapeTableHtml(renderReconPhase(params.tickState.recon)),
    ]);
    for (const specialist of SPECIALIST_IDS) {
      tableRows.push([
        renderTableStrong(SPECIALIST_LABELS[specialist]),
        escapeTableHtml(renderSpecialistPhase(params.tickState.specialists[specialist])),
      ]);
    }
  }
  const progressNote =
    params.tickState == null
      ? REVIEW_PROGRESS_QUEUED_NOTE
      : params.tickState.kind === "terminal"
        ? params.tickState.reason === "stale_head" || params.source === "slash"
          ? "Superseded. Rescheduled for new head."
          : "Superseded by a newer pull request update."
        : REVIEW_PROGRESS_NOTE;
  return [
    REVIEW_SUMMARY_SENTINEL,
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
    REVIEW_SUMMARY_SENTINEL,
    "",
    renderGitHubAlert(
      REVIEW_FAILURE_ALERT,
      `Review did not finish. Run \`${params.retryCommand}\` to try again.`,
    ),
  ].join("\n");
}
