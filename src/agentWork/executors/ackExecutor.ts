import type { Config } from "../../config.js";
import type { Pool } from "pg";
import { logWarn } from "../../evlog.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../review/reviewSchema.js";
import { upsertSummaryCommentWithCreationClaim } from "../../review/publish/publishReview.js";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  triageCancelledNotice,
} from "../../settings/index.js";
import { createPrSurface } from "../../github/prSurface.js";
import { mintInstallationToken } from "../durableJob.js";
import {
  getProgressCommentOwner,
  getReviewQueuePosition,
  getWorkItemCore,
  type ReviewQueuePosition,
} from "../repository.js";
import {
  cancelReviewCheckRunsForWorkItems,
  ensureReviewCheckRunStarted,
} from "../reviewCheckRun.js";
import { buildCiSummaryForSurface } from "../../review/ci/analyzeCi.js";
import {
  parseProgressRevisionState,
  renderReviewCancelledNotice,
  renderReviewProgressComment,
} from "../../review/run/progressComment.js";
import { getAppBotIdentity } from "../../github/appAuth.js";
import type { ReviewMode } from "../../review/reviewSchema.js";
import { prResourceKey, type AckJobData, type WorkStatus } from "../types.js";

const ACK_PROGRESS_ACTIVE_STATUSES = new Set<WorkStatus>(["queued", "running"]);

/** True when this ack may still write the shared progress comment for its work item. */
export async function canAckPublishProgress(
  pool: Pool,
  params: {
    readonly workItemId: string;
    readonly resourceKey: string;
    readonly reviewLens: ReviewMode;
  },
): Promise<boolean> {
  const workItem = await getWorkItemCore(pool, params.workItemId);
  if (workItem == null || !ACK_PROGRESS_ACTIVE_STATUSES.has(workItem.status)) {
    return false;
  }
  const owner = await getProgressCommentOwner(pool, params.resourceKey, params.reviewLens);
  if (owner != null && owner.workItemId !== params.workItemId) {
    return false;
  }
  return true;
}

type AckInstallation = Awaited<ReturnType<typeof mintInstallationToken>>;

function ackPrSurface(
  cfg: Config,
  data: Pick<AckJobData, "installationId" | "owner" | "repo" | "prNumber">,
  installation: AckInstallation,
) {
  return createPrSurface({
    cfg,
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    installation,
  });
}

async function publishAckProgress(
  cfg: Config,
  pool: Pool,
  data: AckJobData & { readonly progress: NonNullable<AckJobData["progress"]> },
  installation: AckInstallation,
  resourceKey: string,
): Promise<void> {
  const prSurface = ackPrSurface(cfg, data, installation);
  const deferredHead = data.progress.headSha === DEFERRED_HEAD_SHA;
  const headSha = deferredHead ? await prSurface.getHeadSha() : data.progress.headSha;
  const ciSummary = await buildCiSummaryForSurface(prSurface, {
    headSha,
    lightweight: true,
    waitMs: 0,
  });
  let queuePosition: ReviewQueuePosition | null = null;
  if (data.workItemId != null) {
    try {
      queuePosition = await getReviewQueuePosition(pool, data.workItemId);
    } catch (e) {
      logWarn("ack_queue_position_failed", {
        workItemId: data.workItemId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Queued stub: Head/Source/(Queue)/(CI) only — no Recon/specialist rows until the review worker starts.
  const body = renderReviewProgressComment({
    mode: data.progress.lens,
    headSha,
    source: data.progress.source,
    ciSummary,
    queuePosition,
    progressRevision: 0,
    progressWorkItemId: data.workItemId,
  });
  await upsertSummaryCommentWithCreationClaim({
    pool,
    workItemId: data.workItemId,
    resourceKey,
    reviewLens: data.progress.lens,
    prSurface,
    body,
    sentinel: REVIEW_SUMMARY_SENTINEL,
    progressRevision: 0,
  });
  // Deferred-head reviews resolve the binding head at claim time; starting the
  // check run here would pin it to an earlier SHA if another push lands first.
  if (data.workItemId && !deferredHead) {
    await ensureReviewCheckRunStarted(pool, {
      prSurface,
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      headSha,
      workItemId: data.workItemId,
      resourceKey,
      reviewLens: data.progress.lens,
    });
  }
}

async function publishCancelProgress(
  cfg: Config,
  pool: Pool,
  data: AckJobData & { readonly cancelProgress: NonNullable<AckJobData["cancelProgress"]> },
  installation: AckInstallation,
  resourceKey: string,
): Promise<void> {
  const prSurface = ackPrSurface(cfg, data, installation);
  const existing = await prSurface.findProgressComment(REVIEW_SUMMARY_SENTINEL);
  const rev = existing?.body != null ? parseProgressRevisionState(existing.body) : null;
  const ownsStub =
    existing != null &&
    (rev?.workItemId == null || rev.workItemId === data.cancelProgress.workItemId);
  const body = renderReviewCancelledNotice({
    attribution: data.cancelProgress.attribution,
    progressRevision: ownsStub ? (rev?.revision ?? 0) : 0,
    progressWorkItemId: data.cancelProgress.workItemId,
  });

  // Comment I/O must not block check cancellation — stale checks stuck in_progress are worse.
  try {
    if (ownsStub && existing != null) {
      await prSurface.editComment(existing.id, body);
    } else {
      await upsertSummaryCommentWithCreationClaim({
        pool,
        workItemId: data.cancelProgress.workItemId,
        resourceKey,
        reviewLens: "review",
        prSurface,
        body,
        sentinel: REVIEW_SUMMARY_SENTINEL,
        progressRevision: 0,
      });
    }
  } catch (error) {
    logWarn("ack_cancel_comment_failed", {
      workItemId: data.cancelProgress.workItemId,
      resourceKey,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // Stale pre-deploy ack jobs may omit cancelledWorkItemIds; fall back to the primary id.
  const cancelledWorkItemIds = data.cancelProgress.cancelledWorkItemIds ?? [
    data.cancelProgress.workItemId,
  ];

  await cancelReviewCheckRunsForWorkItems(pool, {
    prSurface,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    workItemIds: cancelledWorkItemIds,
  });
}

async function publishTriageCancellation(
  prSurface: ReturnType<typeof ackPrSurface>,
  data: AckJobData & { readonly cancelTriage: NonNullable<AckJobData["cancelTriage"]> },
): Promise<void> {
  await prSurface.setAcknowledgementReaction(data.cancelTriage.targets, GITHUB_REACTION_MINUS_ONE);
  await prSurface.replyAt(
    data.cancelTriage.replyTarget,
    triageCancelledNotice(data.cancelTriage.attribution),
  );
}

/** Fire-and-forget ack (reactions, progress stub, slash replies); not a durable work item. */
export async function executeAckJob(cfg: Config, pool: Pool, data: AckJobData): Promise<void> {
  try {
    const bot = await getAppBotIdentity(cfg);
    if (data.commenterId != null && bot.userId === data.commenterId) return;
  } catch (e) {
    logWarn("ack_bot_identity_check_failed", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const installation = await mintInstallationToken(cfg, data.installationId);
  const prSurface = ackPrSurface(cfg, data, installation);
  const resourceKey = prResourceKey(data.owner, data.repo, data.prNumber);

  await prSurface.setAcknowledgementReaction(data.targets, GITHUB_REACTION_EYES);

  // Cancel before progress: `/review force` acks carry both, and the new run's
  // queued stub must be the final state after the cancelled notice lands.
  if (data.cancelProgress) {
    try {
      await publishCancelProgress(
        cfg,
        pool,
        { ...data, cancelProgress: data.cancelProgress },
        installation,
        resourceKey,
      );
    } catch (error) {
      logWarn("ack_cancel_progress_failed", {
        workItemId: data.cancelProgress.workItemId,
        resourceKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (data.cancelTriage) {
    try {
      await publishTriageCancellation(prSurface, { ...data, cancelTriage: data.cancelTriage });
    } catch (error) {
      logWarn("ack_cancel_triage_failed", {
        workItemId: data.cancelTriage.workItemId,
        resourceKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (data.progress) {
    const progressData = { ...data, progress: data.progress };
    if (data.workItemId != null) {
      const mayPublish = await canAckPublishProgress(pool, {
        workItemId: data.workItemId,
        resourceKey,
        reviewLens: progressData.progress.lens,
      });
      if (!mayPublish) {
        logWarn("ack_progress_skipped_stale_owner", {
          workItemId: data.workItemId,
          resourceKey,
          reviewLens: progressData.progress.lens,
        });
      } else {
        await publishAckProgress(cfg, pool, progressData, installation, resourceKey);
      }
    } else {
      await publishAckProgress(cfg, pool, progressData, installation, resourceKey);
    }
  }

  if (data.reply) {
    await prSurface.replyAt(data.reply.target, data.reply.body);
  }

  // Ack-only interactions (help / disabled / usage / cancel) finish here — no durable work item.
  if (data.reply && data.workItemId == null) {
    await prSurface.setAcknowledgementReaction(data.targets, GITHUB_REACTION_PLUS_ONE);
  }
}
