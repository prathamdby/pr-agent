import type { Pool } from "pg";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { findIssueCommentBySentinel, updateIssueComment } from "../../github/reviewPublish.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../review/reviewSchema.js";
import { upsertSummaryCommentWithCreationClaim } from "../../review/publish/publishReview.js";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_PLUS_ONE,
} from "../../settings/index.js";
import { mintInstallationToken } from "../durableJob.js";
import {
  getProgressCommentOwner,
  getReviewQueuePosition,
  getWorkItemCore,
  type ReviewQueuePosition,
} from "../repository.js";
import { ensureReviewCheckRunStarted } from "../reviewCheckRun.js";
import { buildCiSummary } from "../../review/ci/analyzeCi.js";
import {
  parseProgressRevisionState,
  renderReviewCancelledNotice,
  renderReviewProgressComment,
} from "../../review/run/progressComment.js";
import {
  getAppBotIdentity,
  getPullRequestHeadSha,
  postAckReply,
  reactOnAckTargets,
} from "../githubPrSurface.js";
import type { ReviewMode } from "../../review/reviewSchema.js";
import type { AckJobData, WorkStatus } from "../types.js";

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

async function publishAckProgress(
  pool: Pool,
  data: AckJobData & { readonly progress: NonNullable<AckJobData["progress"]> },
  installation: AckInstallation,
  resourceKey: string,
): Promise<void> {
  const headSha =
    data.progress.headSha === DEFERRED_HEAD_SHA
      ? await getPullRequestHeadSha(
          installation.token,
          data.owner,
          data.repo,
          data.prNumber,
          installation.expiresAtTs,
        )
      : data.progress.headSha;
  const ciSummary = await buildCiSummary({
    token: installation.token,
    owner: data.owner,
    repo: data.repo,
    headSha,
    expiresAtTs: installation.expiresAtTs,
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
    token: installation.token,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    body,
    sentinel: REVIEW_SUMMARY_SENTINEL,
    expiresAtTs: installation.expiresAtTs,
    progressRevision: 0,
  });
  if (data.workItemId) {
    await ensureReviewCheckRunStarted(pool, {
      token: installation.token,
      tokenExpiresAtTs: installation.expiresAtTs,
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
  pool: Pool,
  data: AckJobData & { readonly cancelProgress: NonNullable<AckJobData["cancelProgress"]> },
  installation: AckInstallation,
  resourceKey: string,
): Promise<void> {
  const existing = await findIssueCommentBySentinel(
    installation.token,
    data.owner,
    data.repo,
    data.prNumber,
    REVIEW_SUMMARY_SENTINEL,
    installation.expiresAtTs,
  );
  const rev = existing != null ? parseProgressRevisionState(existing.body) : null;
  const ownsStub =
    existing != null &&
    (rev?.workItemId == null || rev.workItemId === data.cancelProgress.workItemId);
  const body = renderReviewCancelledNotice({
    attribution: data.cancelProgress.attribution,
    progressRevision: ownsStub ? (rev?.revision ?? 0) : 0,
    progressWorkItemId: data.cancelProgress.workItemId,
  });

  if (ownsStub && existing != null) {
    await updateIssueComment(
      installation.token,
      data.owner,
      data.repo,
      existing.id,
      body,
      installation.expiresAtTs,
    );
    return;
  }

  await upsertSummaryCommentWithCreationClaim({
    pool,
    workItemId: data.cancelProgress.workItemId,
    resourceKey,
    reviewLens: "review",
    token: installation.token,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    body,
    sentinel: REVIEW_SUMMARY_SENTINEL,
    expiresAtTs: installation.expiresAtTs,
    progressRevision: 0,
  });
}

/** Fire-and-forget ack (reactions, progress stub, slash replies); not a durable work item. */
export async function executeAckJob(cfg: Config, pool: Pool, data: AckJobData): Promise<void> {
  let botUserId: number | undefined;
  try {
    const bot = await getAppBotIdentity(cfg);
    botUserId = bot.userId;
    if (data.commenterId != null && bot.userId === data.commenterId) return;
  } catch (e) {
    logWarn("ack_bot_identity_check_failed", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const installation = await mintInstallationToken(cfg, data.installationId);

  await reactOnAckTargets(
    installation.token,
    data.owner,
    data.repo,
    data.targets,
    GITHUB_REACTION_EYES,
    botUserId,
    installation.expiresAtTs,
  );

  if (data.progress) {
    const progressData = { ...data, progress: data.progress };
    const resourceKey = `${data.owner}/${data.repo}#${data.prNumber}`;
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
        await publishAckProgress(pool, progressData, installation, resourceKey);
      }
    } else {
      await publishAckProgress(pool, progressData, installation, resourceKey);
    }
  }

  if (data.cancelProgress) {
    const resourceKey = `${data.owner}/${data.repo}#${data.prNumber}`;
    try {
      await publishCancelProgress(
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

  if (data.reply) {
    await postAckReply(installation.token, data, data.reply.body, installation.expiresAtTs);
  }

  // Ack-only interactions (help / disabled / usage / cancel) finish here — no durable work item.
  if (data.reply && data.workItemId == null) {
    await reactOnAckTargets(
      installation.token,
      data.owner,
      data.repo,
      data.targets,
      GITHUB_REACTION_PLUS_ONE,
      botUserId,
      installation.expiresAtTs,
    );
  }
}
