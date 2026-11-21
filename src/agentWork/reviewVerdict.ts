import type { ReviewCheckRunConclusion } from "../github/reviewPublish.ts";
import {
  checkRunFindingsSummary,
  FINDING_INVENTORY_UNAVAILABLE_NOTE,
} from "../review/statusCopy.ts";
import type {
  FindingCheck,
  FindingCheckConclusion,
} from "../review/findingIdentity/findingLifecycle.ts";
import type { ReviewCoverage } from "../review/orchestrator/orchestratorTypes.ts";

export const REVIEW_CHECK_RUN_CANCELLED_SUMMARY = "Review was cancelled before completion.";

export function reviewCheckRunName() {
  return ((pinnedReturn: string) => pinnedReturn)("PR Agent Review");
}

export function reviewCheckDetailsUrl(
  owner: string,
  repo: string,
  prNumber: number,
  summaryCommentId?: string | number | null,
) {
  if (summaryCommentId == null)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${summaryCommentId}`,
  );
}

export type ReviewCommitStatusState = "pending" | "success" | "failure" | "error";

export type OwnVerdictOutcome =
  | (FindingCheck & { readonly kind: "published"; readonly summary?: string })
  | { readonly kind: "partial"; readonly note: string }
  | { readonly kind: "cancelled"; readonly summary?: string }
  | { readonly kind: "superseded"; readonly summary?: string }
  | { readonly kind: "stale_head"; readonly summary?: string }
  | { readonly kind: "crashed"; readonly summary?: string }
  | { readonly kind: "not_published"; readonly summary?: string };

export type OwnVerdictSurfaces = {
  readonly checkRun: ReviewCheckRunConclusion;
  readonly commitStatus: Exclude<ReviewCommitStatusState, "pending">;
  readonly summary: string;
};

const DEFAULT_SUMMARIES = {
  cancelled: REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
  superseded: "Review publish was skipped because the work was superseded or cancelled.",
  stale_head: "Review was rescheduled for a newer pull request head.",
  crashed: "PR Agent could not complete the review after retries.",
  not_published: "PR Agent could not publish a structured review.",
} as const;

const PUBLISHED_COMMIT_STATUS = {
  failure: "failure",
  neutral: "error",
  success: "success",
} as const satisfies Record<FindingCheckConclusion, OwnVerdictSurfaces["commitStatus"]>;

export function ownVerdictSurfaces(outcome: OwnVerdictOutcome) {
  switch (outcome.kind) {
    case "published":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: outcome.conclusion,
        commitStatus: PUBLISHED_COMMIT_STATUS[outcome.conclusion],
        summary:
          outcome.summary ??
          (outcome.conclusion === "neutral"
            ? FINDING_INVENTORY_UNAVAILABLE_NOTE
            : checkRunFindingsSummary(outcome.blockingCount)),
      });
    case "partial":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: "neutral",
        commitStatus: "error",
        summary: outcome.note,
      });
    case "cancelled":
    case "superseded":
    case "stale_head":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: "cancelled",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      });
    case "crashed":
    case "not_published":
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)({
        checkRun: "action_required",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      });
    default: {
      const _exhaustive: never = outcome;
      return ((pinnedReturn: OwnVerdictSurfaces) => pinnedReturn)(_exhaustive);
    }
  }
}

export type TerminalOwnCheckStatus = "completed" | "failed" | "cancelled" | "superseded";

export function asTerminalOwnCheckStatus(status: string) {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
      return ((pinnedReturn: TerminalOwnCheckStatus | null) => pinnedReturn)(status);
    default:
      return ((pinnedReturn: TerminalOwnCheckStatus | null) => pinnedReturn)(null);
  }
}

function storedBlockingCount(detail: Record<string, unknown>) {
  const count = detail.ownBlockingCount;
  return ((pinnedReturn: number) => pinnedReturn)(
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 1,
  );
}

export function summaryCommentVerdictMeta(params: {
  readonly kind: "published" | "partial";
  readonly note?: string;
  readonly conclusion: FindingCheckConclusion;
  readonly partialReason?: "unjudged" | "specialists" | "unread";
  readonly blockingCount?: number;
  readonly checkFailSeverity: "P0" | "P1" | "P2" | "P3";
}) {
  const check = {
    ownCheckFailing: params.conclusion === "failure",
    ...(params.conclusion === "neutral" ? { ownCheckIncomplete: true as const } : {}),
    ...(params.blockingCount != null &&
    Number.isSafeInteger(params.blockingCount) &&
    params.blockingCount >= 0
      ? { ownBlockingCount: params.blockingCount }
      : {}),
  };
  const recorded = { ...check, ownCheckFailSeverity: params.checkFailSeverity };
  if (params.kind === "partial") {
    return ((pinnedReturn: {
      readonly ownVerdictKind: "published" | "partial";
      readonly ownVerdictNote?: string;
      readonly ownPartialReason?: "unjudged" | "specialists" | "unread";
      readonly ownCheckFailing: boolean;
      readonly ownCheckIncomplete?: true;
      readonly ownBlockingCount?: number;
      readonly ownCheckFailSeverity: "P0" | "P1" | "P2" | "P3";
    }) => pinnedReturn)({
      ownVerdictKind: "partial",
      ...(params.note != null && params.note.length > 0 ? { ownVerdictNote: params.note } : {}),
      ...(params.partialReason != null ? { ownPartialReason: params.partialReason } : {}),
      ...recorded,
    });
  }
  return ((pinnedReturn: {
    readonly ownVerdictKind: "published" | "partial";
    readonly ownVerdictNote?: string;
    readonly ownPartialReason?: "unjudged" | "specialists" | "unread";
    readonly ownCheckFailing: boolean;
    readonly ownCheckIncomplete?: true;
    readonly ownBlockingCount?: number;
    readonly ownCheckFailSeverity: "P0" | "P1" | "P2" | "P3";
  }) => pinnedReturn)({
    ownVerdictKind: "published",
    ...(params.partialReason != null ? { ownPartialReason: params.partialReason } : {}),
    ...recorded,
  });
}

export type GithubReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export function githubReviewEventFromCloseOutcome(outcome: OwnVerdictOutcome) {
  switch (outcome.kind) {
    case "published":
      switch (outcome.conclusion) {
        case "failure":
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("REQUEST_CHANGES");
        case "success":
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("APPROVE");
        case "neutral":
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("COMMENT");
        default: {
          const _exhaustive: never = outcome.conclusion;
          return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(_exhaustive);
        }
      }
    case "partial":
      return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("COMMENT");
    case "cancelled":
    case "superseded":
    case "stale_head":
    case "crashed":
    case "not_published":
      return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(undefined);
    default: {
      const _exhaustive: never = outcome;
      return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(_exhaustive);
    }
  }
}

export function closeOutcomeForCoverage(
  coverage: ReviewCoverage | undefined,
  check: FindingCheck | undefined,
) {
  if (coverage?.kind === "partial") {
    if (check?.conclusion === "failure") {
      return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
        kind: "published",
        conclusion: "failure",
        blockingCount: check.blockingCount,
      });
    }
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "partial",
      note: coverage.note,
    });
  }
  if (check != null)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "published", ...check });
  return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "not_published" });
}

export function ownVerdictFromSummaryDetail(detail: Record<string, unknown> | null) {
  if (detail == null)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "not_published" });
  if (
    (detail.ownPartialReason === "unjudged" ||
      detail.ownPartialReason === "unread" ||
      detail.ownPartialReason === "specialists") &&
    detail.ownCheckFailing === true
  ) {
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "published",
      conclusion: "failure",
      blockingCount: storedBlockingCount(detail),
    });
  }
  if (detail.ownVerdictKind === "partial") {
    const note =
      typeof detail.ownVerdictNote === "string" && detail.ownVerdictNote.length > 0
        ? detail.ownVerdictNote
        : "Partial specialist coverage.";
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({ kind: "partial", note });
  }
  if (detail.ownCheckFailing === true)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "published",
      conclusion: "failure",
      blockingCount: storedBlockingCount(detail),
    });
  if (detail.ownCheckIncomplete === true)
    return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
      kind: "published",
      conclusion: "neutral",
      blockingCount: 0,
    });
  return ((pinnedReturn: OwnVerdictOutcome) => pinnedReturn)({
    kind: "published",
    conclusion: "success",
    blockingCount: 0,
  });
}
