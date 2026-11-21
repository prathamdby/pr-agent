import { isAppError } from "../../errors/appError.ts";
import { prResourceKey } from "../../agentWork/types.ts";
import { threadMutationLock } from "../findingIdentity/threadMutationLock.ts";
import {
  ensureRediscoveredStandingReview,
  operationIntentMarker,
  publishOnce,
  reviewVerdictReviewOperationKey,
  writePublishStep,
} from "../../state/publish.ts";
import type { ReviewPublishTarget } from "./reviewPublishSession.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.ts";
import {
  githubReviewEventFromCloseOutcome,
  reviewCheckDetailsUrl,
  type GithubReviewEvent,
  type OwnVerdictOutcome,
} from "../../agentWork/reviewVerdict.ts";
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
  readonly target?: ReviewPublishTarget;
  readonly reviewLens?: string;
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

type VerdictEventParams = {
  readonly prSurface: PrSurface;
  readonly event: GithubReviewEvent;
  readonly headSha: string;
  readonly target?: ReviewPublishTarget;
  readonly reviewLens?: string;
  readonly operationKey?: string;
  readonly blockingCount?: number;
  readonly reason?: string;
  readonly summaryUrl?: string;
};

export async function publishReviewVerdictEvent(params: VerdictEventParams) {
  const { event, summaryUrl } = params;
  const reason = params.reason ?? formatVerdictReason(event, params.blockingCount);
  const body = summaryUrl == null ? reason : `${reason} [View review summary](${summaryUrl})`;
  const target = params.target;
  if (target == null) {
    const submitted = await submitTerminalReview({
      prSurface: params.prSurface,
      event,
      body,
      headSha: params.headSha,
    });
    if (submitted === "COMMENT") await dismissStandingVerdicts(params.prSurface);
    return;
  }
  const reviewLens = ("reviewLens" in params ? params.reviewLens : undefined) ?? "review";
  const operationKey = params.operationKey ?? reviewVerdictReviewOperationKey(target.workItemId);
  const operationMarker = operationIntentMarker(operationKey, target.workItemId);
  const rediscovered = await ensureRediscoveredStandingReview(target.db, params.prSurface, {
    workId: target.workItemId,
    prKey: target.resourceKey,
    reviewLens,
    headSha: params.headSha,
    sentinel: REVIEW_SUMMARY_SENTINEL,
  });
  const expectedState =
    event === "APPROVE"
      ? "APPROVED"
      : event === "REQUEST_CHANGES"
        ? "CHANGES_REQUESTED"
        : "COMMENTED";
  if (rediscovered !== undefined && rediscovered.detail.state === expectedState) return;
  const published = await publishOnce({
    db: target.db,
    workId: target.workItemId,
    prKey: target.resourceKey,
    resourceTarget: `standing_review:${params.headSha}`,
    ...(target.laneEpoch !== undefined ? { laneEpoch: target.laneEpoch } : {}),
    ...(target.shutdownRequested !== undefined
      ? { shutdownRequested: target.shutdownRequested }
      : {}),
    ...(target.gate !== undefined ? { gate: target.gate } : {}),
    ...(target.signal !== undefined ? { signal: target.signal } : {}),
    decodeResult: decodePublishedBatch,
    operationKey,
    mutationKind: "github.review_verdict",
    identity: { commitId: params.headSha, operationMarker },
    recover: async () => {
      const found = await findPublishedThreadBatch(
        params.prSurface,
        operationMarker,
        params.headSha,
      );
      return found == null ? { found: false as const } : { found: true as const, value: found };
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
  const posted = reviews.find((review) => review.id === published.reviewId);
  writePublishStep(target.db, {
    workId: target.workItemId,
    prKey: target.resourceKey,
    reviewLens,
    step: "standing_review",
    githubId: published.reviewId,
    detail: { headSha: params.headSha, state: posted?.state ?? expectedState },
  });
  if (posted?.state === "COMMENTED") {
    await dismissStandingVerdicts(params.prSurface);
  }
}

export async function tryPublishCloseOutcomeReview(
  params: Parameters<typeof publishCloseOutcomeReview>[0] & {
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  },
) {
  try {
    await threadMutationLock(prResourceKey(params.owner, params.repo, params.prNumber))(() =>
      publishCloseOutcomeReview(params),
    );
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
