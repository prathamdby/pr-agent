import {
  escapeTableHtml,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableCode,
  renderTableStrong,
} from "../../github/markdownFormat.ts";
import {
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_NO_FINDINGS,
  STATUS_NOT_JUDGED,
  STATUS_RUNNING,
  STATUS_WAITING,
  statusFindings,
} from "../statusCopy.ts";
import {
  REVIEW_FAILURE_ALERT,
  REVIEW_AWAITING_APPROVAL_NOTE,
  REVIEW_AWAITING_MAINTAINER_APPROVAL_NOTE,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_QUEUE_LABEL,
  REVIEW_PROGRESS_QUEUED_NOTE,
  REVIEW_PROGRESS_SOURCE_AUTO,
  REVIEW_PROGRESS_SOURCE_SLASH,
  reviewProgressCancelledNote,
  type ReviewCancelAttribution,
  type AnyReviewLens,
} from "../../settings/index.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.ts";
import type { WorkSource } from "../reviewSchema.ts";
import type { CiSummary } from "../ci/ciFacts.ts";
import { renderCiSummaryCell, shouldRenderCiSummaryRow } from "../ci/ciSummaryCell.ts";
import type { ReviewQueuePosition } from "../../agentWork/types.ts";
import {
  SPECIALIST_IDS,
  type ReconRunPhase,
  type SpecialistId,
  type SpecialistRunPhase,
} from "../orchestrator/orchestratorTypes.ts";
import { renderProgressRevisionComment } from "./commentMarkers.ts";
import { renderStaleReviewMetadataComment } from "./reviewRender.ts";

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
      readonly reason: "superseded" | "stale_head" | "host_abort";
    } & ProgressRoster);

const SPECIALIST_LABELS: Record<SpecialistId, string> = {
  correctness: "Correctness",
  security: "Security",
  quality: "Quality",
  tests: "Tests",
};

function renderReconPhase(phase: ReconPhase) {
  switch (phase) {
    case "running":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_RUNNING);
    case "done":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_DONE);
    default: {
      const exhaustive: never = phase;
      return ((pinnedReturn: string) => pinnedReturn)(exhaustive);
    }
  }
}

function renderSpecialistPhase(state: SpecialistPhase) {
  switch (state.phase) {
    case "waiting":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_WAITING);
    case "running":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_RUNNING);
    case "done":
      return ((pinnedReturn: string) => pinnedReturn)(statusFindings(state.findingsAccepted));
    case "no_findings":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_NO_FINDINGS);
    case "failed":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_FAILED);
    case "unjudged":
      return ((pinnedReturn: string) => pinnedReturn)(STATUS_NOT_JUDGED);
    default: {
      const exhaustive: never = state;
      return ((pinnedReturn: string) => pinnedReturn)(exhaustive);
    }
  }
}

export function initialProgressTickState() {
  return ((pinnedReturn: Extract<SpecialistTickState, { kind: "specialists" }>) => pinnedReturn)({
    kind: "specialists",
    recon: "running",
    specialists: {
      correctness: { phase: "waiting" },
      security: { phase: "waiting" },
      quality: { phase: "waiting" },
      tests: { phase: "waiting" },
    },
  });
}

export function formatReviewQueuePosition(position: ReviewQueuePosition) {
  return ((pinnedReturn: string) => pinnedReturn)(`#${position.position} of ${position.total}`);
}

function terminalProgressNote(
  reason: "superseded" | "stale_head" | "host_abort",
  source: WorkSource,
) {
  switch (reason) {
    case "stale_head":
      return ((pinnedReturn: string) => pinnedReturn)("Superseded. Rescheduled for new head.");
    case "superseded":
      return ((pinnedReturn: string) => pinnedReturn)(
        source === "slash"
          ? "Superseded. Rescheduled for new head."
          : "Superseded by a newer pull request update.",
      );
    case "host_abort":
      return ((pinnedReturn: string) => pinnedReturn)("Stopped. The host aborted this run.");
    default: {
      const exhaustive: never = reason;
      return ((pinnedReturn: string) => pinnedReturn)(exhaustive);
    }
  }
}

export function renderReviewCancelledNotice(params: {
  attribution: ReviewCancelAttribution;
  progressRevision?: number;
  progressWorkItemId?: string;
}) {
  const parts = [
    REVIEW_SUMMARY_SENTINEL,
    "",
    renderGitHubAlert(REVIEW_FAILURE_ALERT, reviewProgressCancelledNote(params.attribution)),
  ];
  if (params.progressRevision != null || params.progressWorkItemId != null) {
    parts.push(
      "",
      renderProgressRevisionComment(params.progressRevision ?? 0, params.progressWorkItemId),
    );
  }
  return ((pinnedReturn: string) => pinnedReturn)(parts.join("\n"));
}

export function renderReviewProgressComment(params: {
  mode: AnyReviewLens;
  headSha: string;
  source: WorkSource;
  ciSummary?: CiSummary | null;
  ciVersion?: number;
  tickState?: SpecialistTickState;
  queuePosition?: ReviewQueuePosition | null;
  progressRevision?: number;
  progressWorkItemId?: string;
}) {
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
    tableRows.push([
      renderTableStrong("CI"),
      renderCiSummaryCell(params.ciSummary, params.headSha, params.ciVersion),
    ]);
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
        ? terminalProgressNote(params.tickState.reason, params.source)
        : REVIEW_PROGRESS_NOTE;
  return ((pinnedReturn: string) => pinnedReturn)(
    [
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
    ].join("\n"),
  );
}

export function renderReviewFailureNotice(params: {
  mode: AnyReviewLens;
  retryCommand: string;
  findingsSection?: string;
}) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      REVIEW_SUMMARY_SENTINEL,
      "",
      renderGitHubAlert(
        REVIEW_FAILURE_ALERT,
        `Review did not finish. Run \`${params.retryCommand}\` to try again.`,
      ),
      ...(params.findingsSection != null && params.findingsSection.length > 0
        ? ["", params.findingsSection]
        : []),
    ].join("\n"),
  );
}

export function renderReviewAwaitingApprovalNotice(maintainerOnly = false) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      REVIEW_SUMMARY_SENTINEL,
      "",
      renderGitHubAlert(
        REVIEW_OVERVIEW_ALERT,
        maintainerOnly ? REVIEW_AWAITING_MAINTAINER_APPROVAL_NOTE : REVIEW_AWAITING_APPROVAL_NOTE,
      ),
    ].join("\n"),
  );
}
