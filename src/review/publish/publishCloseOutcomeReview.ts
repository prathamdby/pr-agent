import type { Pool, PoolClient } from "pg";
import { isAppError } from "../../errors/appError.ts";
import { prResourceKey } from "../../agentWork/types.ts";
import { threadMutationLock } from "../findingIdentity/threadMutationLock.ts";
import {
  operationIntentMarker,
  publishOnce,
  reviewVerdictReviewOperationKey,
} from "../../agentWork/publishOnce.ts";
import {
  githubReviewEventFromCloseOutcome,
  reviewCheckDetailsUrl,
  type GithubReviewEvent,
  type OwnVerdictOutcome,
} from "../../agentWork/reviewVerdict.ts";
import { fenceForEpoch } from "../../agentWork/writeFence.ts";
import { logWarn } from "../../evlog.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { isSelfPullRequestReviewEventRejection } from "../../github/githubErrors.ts";
import { isKnownNoAcceptanceMutationError } from "../../github/mutationErrorContract.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import { findPublishedThreadBatch } from "../../github/prSurfaceHelpers.ts";
import { decodePublishedBatch } from "../../github/prSurfaceResults.ts";
import {
  FINDING_INVENTORY_UNAVAILABLE_NOTE,
  TERMINAL_REVIEW_DISMISS_MESSAGE,
} from "../statusCopy.ts";

function formatVerdictReason(event: GithubReviewEvent, blockingCount: number | undefined) {
  if (event === "APPROVE")
    return ((pinnedReturn: string) => pinnedReturn)("No blocking findings remain.");
  if (event === "COMMENT")
    return ((pinnedReturn: string) => pinnedReturn)(
      "Review coverage was incomplete, so PR Agent did not approve.",
    );
  if (blockingCount == null || blockingCount < 1)
    return ((pinnedReturn: string) => pinnedReturn)("Blocking findings still need attention.");
  return ((pinnedReturn: string) => pinnedReturn)(
    blockingCount === 1
      ? "1 blocking finding needs attention."
      : `${blockingCount} blocking findings need attention.`,
  );
}

async function submitTerminalReview(params: {
  readonly prSurface: PrSurface;
  readonly event: GithubReviewEvent;
  readonly body: string;
  readonly headSha: string;
}) {
  try {
    await params.prSurface.publishThreadBatch({
      body: params.body,
      event: params.event,
      commitId: params.headSha,
    });
    return ((pinnedReturn: GithubReviewEvent | Promise<GithubReviewEvent>) => pinnedReturn)(
      params.event,
    );
  } catch (error) {
    if (
      (params.event === "APPROVE" || params.event === "REQUEST_CHANGES") &&
      isSelfPullRequestReviewEventRejection(error)
    ) {
      await params.prSurface.publishThreadBatch({
        body: params.body,
        event: "COMMENT",
        commitId: params.headSha,
      });
      return ((pinnedReturn: GithubReviewEvent | Promise<GithubReviewEvent>) => pinnedReturn)(
        "COMMENT",
      );
    }
    throw error;
  }
}

async function dismissStandingVerdicts(prSurface: PrSurface) {
  const botLogin = await prSurface.getBotLogin();
  const reviews = await prSurface.listPullRequestReviews();
  let firstError: unknown;
  for (const review of reviews) {
    if (review.authorLogin !== botLogin) continue;
    if (review.state !== "CHANGES_REQUESTED" && review.state !== "APPROVED") continue;
    try {
      await prSurface.dismissPullRequestReview({
        reviewId: review.id,
        message: TERMINAL_REVIEW_DISMISS_MESSAGE,
      });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError != null) throw firstError;
}

export async function publishCloseOutcomeReview(params: {
  readonly prSurface: PrSurface;
  readonly outcome: OwnVerdictOutcome;
  readonly headSha: string;
  readonly summaryCommentId?: number | null;
  readonly workItemId?: string;
  readonly pool?: Pool | PoolClient;
  readonly leaseEpoch?: number | null;
}) {
  const event = githubReviewEventFromCloseOutcome(params.outcome);
  if (event == null) return;
  const { prSurface, outcome } = params;
  await publishReviewVerdictEvent({
    ...params,
    event,
    blockingCount: outcome.kind === "published" ? outcome.blockingCount : undefined,
    reason:
      outcome.kind === "published" && outcome.conclusion === "neutral"
        ? `${FINDING_INVENTORY_UNAVAILABLE_NOTE} PR Agent did not approve.`
        : undefined,
    summaryUrl: reviewCheckDetailsUrl(
      prSurface.owner,
      prSurface.repo,
      prSurface.prNumber,
      params.summaryCommentId,
    ),
  });
}

export async function publishReviewVerdictEvent(params: {
  readonly prSurface: PrSurface;
  readonly event: GithubReviewEvent;
  readonly headSha: string;
  readonly workItemId?: string;
  readonly pool?: Pool | PoolClient;
  readonly leaseEpoch?: number | null;
  readonly operationKey?: string;
  readonly blockingCount?: number;
  readonly reason?: string;
  readonly summaryUrl?: string;
}) {
  const { event, summaryUrl } = params;
  const reason = params.reason ?? formatVerdictReason(event, params.blockingCount);
  const body = summaryUrl == null ? reason : `${reason} [View review summary](${summaryUrl})`;
  if (params.pool == null || params.workItemId == null) {
    const submitted = await submitTerminalReview({
      prSurface: params.prSurface,
      event,
      body,
      headSha: params.headSha,
    });
    if (submitted === "COMMENT") await dismissStandingVerdicts(params.prSurface);
    return;
  }
  const operationKey = params.operationKey ?? reviewVerdictReviewOperationKey(params.workItemId);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const published = await publishOnce({
    decodeResult: decodePublishedBatch,
    fence: fenceForEpoch(params.leaseEpoch),
    client: params.pool,
    workItemId: params.workItemId,
    operationKey,
    mutationKind: "github.review_verdict",
    leaseEpoch: params.leaseEpoch,
    detail: {
      commitId: params.headSha,
      operationMarker,
    },
    recover: async () => {
      const found = await findPublishedThreadBatch(
        params.prSurface,
        operationMarker,
        params.headSha,
      );
      return found == null
        ? { kind: "absent" as const }
        : { kind: "reconciled" as const, value: found };
    },
    isKnownNoAcceptanceError: isKnownNoAcceptanceMutationError,
    mutate: async () => {
      await submitTerminalReview({
        prSurface: params.prSurface,
        event,
        body: `${body}\n${operationMarker}`,
        headSha: params.headSha,
      });
      const found = await findPublishedThreadBatch(
        params.prSurface,
        operationMarker,
        params.headSha,
      );
      if (found == null) {
        throw new Error("Terminal review did not appear after publish");
      }
      return found;
    },
  });
  const reviews = await params.prSurface.listPullRequestReviews();
  if (reviews.some((review) => review.id === published.reviewId && review.state === "COMMENTED")) {
    await dismissStandingVerdicts(params.prSurface);
  }
}

export async function tryPublishCloseOutcomeReview(
  params: Omit<Parameters<typeof publishCloseOutcomeReview>[0], "pool"> & {
    readonly pool?: Pool;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  },
) {
  try {
    await threadMutationLock(
      params.pool,
      prResourceKey(params.owner, params.repo, params.prNumber),
    )(() => publishCloseOutcomeReview(params));
  } catch (error) {
    logWarn("review_verdict_review_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      message: errorMessage(error),
      ...(isAppError(error) ? { reason: error.code } : {}),
    });
  }
}
