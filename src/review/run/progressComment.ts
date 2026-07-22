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
import { reviewSummarySentinelForMode, type ReviewMode, type WorkSource } from "../reviewSchema.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { renderCiSummaryCell, shouldRenderCiSummaryRow } from "../ci/renderCiSummary.js";
import { renderStaleReviewMetadataComment } from "./reviewRender.js";
import {
  SPECIALIST_DISPLAY_LABEL,
  SPECIALIST_IDS,
  type SpecialistId,
} from "../orchestrator/specialistReport.js";

export type SpecialistTickPhase =
  | { phase: "running" }
  | { phase: "done"; threadsPublished: number }
  | { phase: "no_findings" }
  | { phase: "failed" };

export type SpecialistTickState = Record<SpecialistId, SpecialistTickPhase>;

/** Run-level progress phase (decision 26 terminal stub). */
export type ProgressRunPhase = "in_progress" | "superseded_rescheduled";

function renderSpecialistTickCell(tick: SpecialistTickPhase): string {
  switch (tick.phase) {
    case "running":
      return escapeTableHtml("⏳ running");
    case "done":
      return escapeTableHtml(
        `✅ ${tick.threadsPublished} thread${tick.threadsPublished === 1 ? "" : "s"}`,
      );
    case "no_findings":
      return escapeTableHtml("⚪ no findings");
    case "failed":
      return escapeTableHtml("⚠️ failed (coverage partial)");
    default: {
      const exhaustive: never = tick;
      return exhaustive;
    }
  }
}

export function renderReviewProgressComment(params: {
  mode: ReviewMode;
  headSha: string;
  source: WorkSource;
  ciSummary?: CiSummary | null;
  specialistTicks?: SpecialistTickState;
  runPhase?: ProgressRunPhase;
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

  const sections = [
    reviewSummarySentinelForMode(params.mode),
    "",
    renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_PROGRESS_NOTE),
    "",
    renderKeyValueTable(tableRows),
  ];

  if (params.runPhase === "superseded_rescheduled") {
    sections.push(
      "",
      renderGitHubAlert(REVIEW_OVERVIEW_ALERT, "superseded — rescheduled for new head"),
    );
  }

  if (params.specialistTicks != null) {
    const ticks = params.specialistTicks;
    const specialistRows: Array<[string, string]> = SPECIALIST_IDS.map((id) => [
      renderTableStrong(SPECIALIST_DISPLAY_LABEL[id]),
      renderSpecialistTickCell(ticks[id]),
    ]);
    sections.push("", renderKeyValueTable(specialistRows));
  }

  sections.push(
    "",
    renderStaleReviewMetadataComment({
      headSha: params.headSha,
      mode: params.mode,
      stale: false,
    }),
  );

  return sections.join("\n");
}

export function renderReviewFailureNotice(params: {
  mode: ReviewMode;
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

/** Initial all-running tick state used when specialists are dispatched. */
export function initialSpecialistTickState(): SpecialistTickState {
  return {
    correctness: { phase: "running" },
    security: { phase: "running" },
    quality: { phase: "running" },
    tests: { phase: "running" },
  };
}
