import type { Pool } from "pg";
import { logWarn } from "../evlog.js";
import { isKnownNoAcceptanceMutationError } from "../github/mutationErrorContract.js";
import type { PrSurface } from "../github/prSurface.js";
import type { ReviewCheckRunConclusion } from "../github/reviewPublish.js";
import type { ReviewFinding } from "../review/reviewSchema.js";
import { DEFERRED_HEAD_SHA } from "../settings/index.js";
import type { AnyReviewLens } from "../settings/legacyReviewLenses.js";
import {
  cancelReviewCheckRun,
  completeReviewCheckRun,
  REVIEW_CHECK_RUN_CANCELLED_SUMMARY,
  reviewCheckDetailsUrl,
  reviewCheckRunOutcome,
} from "./reviewCheckRun.js";
import { getSummaryCommentGithubId, getWorkItemCore } from "./repository.js";
import type { WorkStatus } from "./types.js";
import { reviewCommitStatusOperationKey, withOperationIntent } from "./withOperationIntent.js";

export type ReviewCommitStatusState = "pending" | "success" | "failure" | "error";

export type OwnVerdictOutcome =
  | {
      readonly kind: "published";
      readonly findings: readonly Pick<ReviewFinding, "severity">[];
      readonly summary?: string;
    }
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

export function ownVerdictSurfaces(outcome: OwnVerdictOutcome): OwnVerdictSurfaces {
  switch (outcome.kind) {
    case "published": {
      const check = reviewCheckRunOutcome(outcome.findings);
      return {
        checkRun: check.conclusion,
        commitStatus: check.conclusion === "failure" ? "failure" : "success",
        summary: outcome.summary ?? check.summary,
      };
    }
    case "partial":
      return { checkRun: "neutral", commitStatus: "error", summary: outcome.note };
    case "cancelled":
    case "superseded":
    case "stale_head":
      return {
        checkRun: "cancelled",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      };
    case "crashed":
    case "not_published":
      return {
        checkRun: "action_required",
        commitStatus: "error",
        summary: outcome.summary ?? DEFAULT_SUMMARIES[outcome.kind],
      };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function isTerminalWorkStatus(status: WorkStatus): boolean {
  switch (status) {
    case "queued":
    case "running":
      return false;
    case "superseded":
    case "cancelled":
    case "completed":
    case "failed":
      return true;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export type CloseOwnVerdictParams = {
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly reviewLens: AnyReviewLens;
  readonly headSha: string;
  readonly outcome: OwnVerdictOutcome;
  readonly commitStatusEnabled: boolean;
  /**
   * Live execution fence. Null means the projector or sweeper: no epoch exists,
   * so the write is allowed only after `agent_work_items` is terminal.
   * Omit on unleased ack so cancel still lands.
   */
  readonly leaseEpoch?: number | null;
  readonly detailsUrl?: string;
};

type OwnCommitStatusParams = {
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly state: ReviewCommitStatusState;
  readonly description: string;
  readonly targetUrl?: string;
  readonly leaseEpoch?: number | null;
};

async function writeOwnCommitStatus(params: OwnCommitStatusParams): Promise<void> {
  if (params.headSha === DEFERRED_HEAD_SHA || params.headSha.length === 0) return;
  const status = {
    state: params.state,
    description: params.description,
    targetUrl: params.targetUrl,
  };
  try {
    await withOperationIntent<void>({
      client: params.pool,
      workItemId: params.workItemId,
      operationKey: reviewCommitStatusOperationKey(
        params.resourceKey,
        params.headSha,
        params.state,
      ),
      mutationKind: "github.review_commit_status",
      leaseEpoch: params.leaseEpoch,
      allowsUndefinedResult: true,
      detail: {
        step: "commit_status",
        resourceKey: params.resourceKey,
        headSha: params.headSha,
        context: "pr-agent/review",
        ...status,
      },
      recover: async () => {
        const current = await params.prSurface.getCiStatus(params.headSha);
        const found = current.legacyStatuses.some(
          (legacy) =>
            legacy.context === "pr-agent/review" &&
            legacy.state === status.state &&
            legacy.description === status.description &&
            legacy.targetUrl === (status.targetUrl ?? null),
        );
        return found
          ? { kind: "reconciled" as const, value: undefined }
          : { kind: "absent" as const };
      },
      isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
      mutate: () => params.prSurface.setReviewCommitStatus(params.headSha, status),
    });
  } catch (error) {
    logWarn("review_commit_status_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      headSha: params.headSha,
      state: params.state,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Post `pending` under `review:commit_status:<resource>:<head>:pending`. */
export async function postOwnVerdictPending(params: {
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly commitStatusEnabled: boolean;
  readonly leaseEpoch?: number | null;
  readonly detailsUrl?: string;
}): Promise<void> {
  if (!params.commitStatusEnabled) return;
  await writeOwnCommitStatus({
    ...params,
    state: "pending",
    description: "PR Agent review is in progress.",
    targetUrl: params.detailsUrl,
  });
}

async function completeOwnCheckRun(
  params: CloseOwnVerdictParams,
  surfaces: OwnVerdictSurfaces,
): Promise<void> {
  if (surfaces.checkRun === "cancelled") {
    await cancelReviewCheckRun(params.pool, {
      prSurface: params.prSurface,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      reviewLens: params.reviewLens,
      leaseEpoch: params.leaseEpoch,
      headSha: params.headSha,
      detailsUrl: params.detailsUrl,
      summary: surfaces.summary,
    });
    return;
  }
  await completeReviewCheckRun(params.pool, {
    prSurface: params.prSurface,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    workItemId: params.workItemId,
    resourceKey: params.resourceKey,
    reviewLens: params.reviewLens,
    leaseEpoch: params.leaseEpoch,
    conclusion: surfaces.checkRun,
    summary: surfaces.summary,
    detailsUrl: params.detailsUrl,
  });
}

export async function closeOwnVerdict(params: CloseOwnVerdictParams): Promise<void> {
  if (params.leaseEpoch === null) {
    const core = await getWorkItemCore(params.pool, params.workItemId);
    if (core == null || !isTerminalWorkStatus(core.status)) return;
  }

  const surfaces = ownVerdictSurfaces(params.outcome);
  await completeOwnCheckRun(params, surfaces);
  if (params.commitStatusEnabled) {
    await writeOwnCommitStatus({
      pool: params.pool,
      prSurface: params.prSurface,
      workItemId: params.workItemId,
      resourceKey: params.resourceKey,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      state: surfaces.commitStatus,
      description: surfaces.summary,
      targetUrl: params.detailsUrl,
      leaseEpoch: params.leaseEpoch,
    });
  }
}

export async function closeOwnVerdictsForWorkItems(
  pool: Pool,
  params: {
    readonly prSurface: PrSurface;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
    readonly workItemIds: readonly string[];
    readonly commitStatusEnabled: boolean;
    readonly outcome: OwnVerdictOutcome;
  },
): Promise<void> {
  await Promise.all(
    params.workItemIds.map(async (workItemId) => {
      try {
        const core = await getWorkItemCore(pool, workItemId);
        if (core == null || core.type !== "review" || core.reviewLens == null) return;
        const summaryCommentId = await getSummaryCommentGithubId(
          pool,
          core.resourceKey,
          core.reviewLens,
        );
        await closeOwnVerdict({
          pool,
          prSurface: params.prSurface,
          owner: params.owner,
          repo: params.repo,
          prNumber: params.prNumber,
          workItemId,
          resourceKey: core.resourceKey,
          reviewLens: core.reviewLens,
          headSha: core.headSha,
          outcome: params.outcome,
          commitStatusEnabled: params.commitStatusEnabled,
          detailsUrl: reviewCheckDetailsUrl(
            params.owner,
            params.repo,
            params.prNumber,
            summaryCommentId,
          ),
        });
      } catch (error) {
        logWarn("review_check_run_cancel_item_failed", {
          owner: params.owner,
          repo: params.repo,
          pr: params.prNumber,
          workItemId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
