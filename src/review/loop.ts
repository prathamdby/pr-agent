import {
  LIGHTWEIGHT_REVIEW_COMPLETION_LEAD,
  REVIEW_LOOP_LABEL_NEXT,
  REVIEW_LOOP_LEAD,
  REVIEW_LOOP_NEXT_FIX_CI,
  REVIEW_LOOP_NEXT_HUMAN,
  REVIEW_LOOP_NEXT_LIGHTWEIGHT,
  REVIEW_LOOP_NEXT_RUN_REVIEW,
  REVIEW_LOOP_NEXT_STALE_REVIEW,
  REVIEW_LOOP_NEXT_TRIAGE_BLOCKING,
  REVIEW_LOOP_NEXT_TRIAGE_OPTIONAL,
  REVIEW_LOOP_NEXT_WAIT_CI,
  REVIEW_LOOP_NEXT_WAIT_REVIEW,
  REVIEW_LOOP_REVIEW_IN_PROGRESS,
  REVIEW_LOOP_REVIEW_NONE,
  REVIEW_LOOP_SENTINEL,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_QUEUED_NOTE,
  reviewProgressCancelledNote,
} from "../settings/index.js";
import {
  escapeTableHtml,
  escapeTablePlainCell,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableStrong,
} from "../github/markdownFormat.js";
import { parseReviewMetaFromCommentBody } from "./ci/reviewMetaParse.js";
import type { CiSummaryStatus } from "./ci/ciSummaryTypes.js";
import type { BotFindingThread } from "./run/reviewPriorFeedback.js";
import type { ListReviewThreadResolutionResult } from "../github/reviewThreadResolution.js";
import type { ReviewFinding } from "./reviewSchema.js";
import { normalizeGitHeadSha } from "./run/reviewRunFooter.js";

export type MergeLoopReviewState =
  | { readonly kind: "none" }
  | { readonly kind: "in_progress" }
  | {
      readonly kind: "lightweight";
      readonly headSha: string;
      readonly current: boolean;
    }
  | {
      readonly kind: "complete";
      readonly headSha: string;
      readonly current: boolean;
    };

export type MergeLoopEvidence = {
  readonly review: MergeLoopReviewState;
  readonly openP0P1: number;
  readonly openP2P3: number;
  readonly ciStatus?: CiSummaryStatus;
};

export type MergeLoopBriefing = {
  readonly reviewLine: string;
  readonly openP0P1: number;
  readonly openP2P3: number;
  readonly ciLine: string | null;
  readonly nextAction: string;
};

function headsMatch(reviewed: string, current: string): boolean {
  const left = normalizeGitHeadSha(reviewed);
  const right = normalizeGitHeadSha(current);
  if (left == null || right == null) return reviewed.toLowerCase() === current.toLowerCase();
  return left === right;
}

function isCancelledProgress(body: string): boolean {
  return (
    body.includes(reviewProgressCancelledNote({ kind: "merged" })) ||
    body.includes("Cancelled by @")
  );
}

export function reviewStateFromProgressComment(
  body: string | null | undefined,
  currentHeadSha: string,
): MergeLoopReviewState {
  if (body == null || body.trim().length === 0) return { kind: "none" };
  if (isCancelledProgress(body)) return { kind: "none" };
  if (body.includes(REVIEW_PROGRESS_NOTE) || body.includes(REVIEW_PROGRESS_QUEUED_NOTE)) {
    return { kind: "in_progress" };
  }
  const meta = parseReviewMetaFromCommentBody(body);
  const headSha = meta?.headSha && meta.headSha !== "invalid" ? meta.headSha : null;
  if (headSha == null) return { kind: "none" };
  const current = headsMatch(headSha, currentHeadSha);
  if (body.includes(LIGHTWEIGHT_REVIEW_COMPLETION_LEAD)) {
    return { kind: "lightweight", headSha, current };
  }
  return { kind: "complete", headSha, current };
}

export function countOpenFindingSeverities(
  threads: readonly BotFindingThread[],
  resolution: ListReviewThreadResolutionResult,
): { readonly openP0P1: number; readonly openP2P3: number } {
  let openP0P1 = 0;
  let openP2P3 = 0;
  const resolutionOk = resolution.status === "ok" || resolution.status === "partial";
  for (const thread of threads) {
    if (resolutionOk) {
      const row = resolution.byRootCommentId.get(thread.rootCommentId);
      if (row?.isResolved === true) continue;
    }
    if (thread.severity === "P0" || thread.severity === "P1") openP0P1 += 1;
    else openP2P3 += 1;
  }
  return { openP0P1, openP2P3 };
}

export function countPayloadFindingSeverities(findings: readonly ReviewFinding[]): {
  readonly openP0P1: number;
  readonly openP2P3: number;
} {
  let openP0P1 = 0;
  let openP2P3 = 0;
  for (const finding of findings) {
    if (finding.severity === "P0" || finding.severity === "P1") openP0P1 += 1;
    else openP2P3 += 1;
  }
  return { openP0P1, openP2P3 };
}

function ciLine(status: CiSummaryStatus | undefined): string | null {
  if (status == null || status === "none") return null;
  return status;
}

function nextActionForOpenWork(evidence: MergeLoopEvidence): string {
  if (evidence.openP0P1 > 0) return REVIEW_LOOP_NEXT_TRIAGE_BLOCKING;
  if (evidence.ciStatus === "failing") return REVIEW_LOOP_NEXT_FIX_CI;
  if (evidence.ciStatus === "pending") return REVIEW_LOOP_NEXT_WAIT_CI;
  if (evidence.openP2P3 > 0) return REVIEW_LOOP_NEXT_TRIAGE_OPTIONAL;
  return REVIEW_LOOP_NEXT_HUMAN;
}

export function evaluateMergeLoop(evidence: MergeLoopEvidence): MergeLoopBriefing {
  const review = evidence.review;
  switch (review.kind) {
    case "none":
      return {
        reviewLine: REVIEW_LOOP_REVIEW_NONE,
        openP0P1: evidence.openP0P1,
        openP2P3: evidence.openP2P3,
        ciLine: ciLine(evidence.ciStatus),
        nextAction: REVIEW_LOOP_NEXT_RUN_REVIEW,
      };
    case "in_progress":
      return {
        reviewLine: REVIEW_LOOP_REVIEW_IN_PROGRESS,
        openP0P1: evidence.openP0P1,
        openP2P3: evidence.openP2P3,
        ciLine: ciLine(evidence.ciStatus),
        nextAction: REVIEW_LOOP_NEXT_WAIT_REVIEW,
      };
    case "lightweight":
      return {
        reviewLine: review.current
          ? `Docs-only skip on \`${shortSha(review.headSha)}\` (current head)`
          : `Docs-only skip on \`${shortSha(review.headSha)}\` (not current head)`,
        openP0P1: evidence.openP0P1,
        openP2P3: evidence.openP2P3,
        ciLine: ciLine(evidence.ciStatus),
        nextAction: review.current ? REVIEW_LOOP_NEXT_LIGHTWEIGHT : REVIEW_LOOP_NEXT_STALE_REVIEW,
      };
    case "complete":
      return {
        reviewLine: review.current
          ? `Complete on \`${shortSha(review.headSha)}\` (current head)`
          : `Complete on \`${shortSha(review.headSha)}\` (not current head)`,
        openP0P1: evidence.openP0P1,
        openP2P3: evidence.openP2P3,
        ciLine: ciLine(evidence.ciStatus),
        nextAction: review.current
          ? nextActionForOpenWork(evidence)
          : REVIEW_LOOP_NEXT_STALE_REVIEW,
      };
    default: {
      const exhaustive: never = review;
      return exhaustive;
    }
  }
}

function shortSha(headSha: string): string {
  return normalizeGitHeadSha(headSha)?.slice(0, 7) ?? headSha.slice(0, 7);
}

export function renderMergeLoopComment(briefing: MergeLoopBriefing): string {
  const rows: Array<[string, string]> = [
    [renderTableStrong("Review"), escapeTablePlainCell(briefing.reviewLine)],
    [renderTableStrong("Open P0/P1"), escapeTableHtml(String(briefing.openP0P1))],
    [renderTableStrong("Open P2/P3"), escapeTableHtml(String(briefing.openP2P3))],
  ];
  if (briefing.ciLine != null) {
    rows.push([renderTableStrong("CI"), escapeTableHtml(briefing.ciLine)]);
  }
  rows.push([renderTableStrong(REVIEW_LOOP_LABEL_NEXT), escapeTablePlainCell(briefing.nextAction)]);
  return [
    REVIEW_LOOP_SENTINEL,
    "",
    renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_LOOP_LEAD),
    "",
    renderKeyValueTable(rows),
  ].join("\n");
}

export function evaluateSummaryMergeLoop(params: {
  readonly findings: readonly ReviewFinding[];
  readonly ciStatus?: CiSummaryStatus;
  readonly staleReview?: boolean;
  readonly headSha: string;
}): MergeLoopBriefing {
  const counts = countPayloadFindingSeverities(params.findings);
  return evaluateMergeLoop({
    review: {
      kind: "complete",
      headSha: params.headSha,
      current: params.staleReview !== true,
    },
    openP0P1: counts.openP0P1,
    openP2P3: counts.openP2P3,
    ciStatus: params.ciStatus,
  });
}

export function mergeLoopNextActionForSummary(params: {
  readonly findings: readonly ReviewFinding[];
  readonly ciStatus?: CiSummaryStatus;
  readonly staleReview?: boolean;
  readonly headSha: string;
}): string {
  return evaluateSummaryMergeLoop(params).nextAction;
}
