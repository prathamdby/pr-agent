import type { Pool, PoolClient } from "pg";
import {
  operationIntentMarker,
  publishOnce,
  reviewVerdictReviewOperationKey,
} from "../../agentWork/publishOnce.ts";
import {
  githubReviewEventFromCloseOutcome,
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
import { TERMINAL_REVIEW_BODY, TERMINAL_REVIEW_DISMISS_MESSAGE } from "../statusCopy.ts";

async function submitTerminalReview(params: {
  readonly prSurface: PrSurface;
  readonly event: GithubReviewEvent;
  readonly body: string;
  readonly headSha: string;
}): Promise<GithubReviewEvent> {
  try {
    await params.prSurface.publishThreadBatch({
      body: params.body,
      event: params.event,
      commitId: params.headSha,
    });
    return params.event;
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
      return "COMMENT";
    }
    throw error;
  }
}

async function dismissStandingVerdicts(prSurface: PrSurface): Promise<void> {
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
  readonly workItemId?: string;
  readonly pool?: Pool | PoolClient;
  readonly leaseEpoch?: number | null;
}): Promise<void> {
  const event = githubReviewEventFromCloseOutcome(params.outcome);
  if (event == null) return;
  if (params.pool == null || params.workItemId == null) {
    const submitted = await submitTerminalReview({
      prSurface: params.prSurface,
      event,
      body: TERMINAL_REVIEW_BODY,
      headSha: params.headSha,
    });
    if (submitted === "COMMENT") await dismissStandingVerdicts(params.prSurface);
    return;
  }
  const operationKey = reviewVerdictReviewOperationKey(params.workItemId);
  const operationMarker = operationIntentMarker(operationKey, params.workItemId);
  const body = `${TERMINAL_REVIEW_BODY}\n${operationMarker}`;
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
        body,
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
  params: Parameters<typeof publishCloseOutcomeReview>[0] & {
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: number;
  },
): Promise<void> {
  try {
    await publishCloseOutcomeReview(params);
  } catch (error) {
    logWarn("review_verdict_review_failed", {
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      message: errorMessage(error),
    });
  }
}
