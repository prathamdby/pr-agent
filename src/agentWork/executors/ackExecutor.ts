import { productionInstallationSurface } from "../installationSurface.js";
import { unfencedSurface } from "../writeFence.js";
import {
  type Config,
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_MINUS_ONE,
  GITHUB_REACTION_PLUS_ONE,
  triageCancelledNotice,
  type GithubReactionContent,
} from "../../settings/index.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { logWarn } from "../../evlog.js";
import { REVIEW_SUMMARY_SENTINEL } from "../../review/reviewSchema.js";
import { createReviewSummaryComment } from "../../review/publish/reviewSummaryComment.js";
import { getProgressCommentOwner } from "../publishRecordRepository.js";
import {
  getReviewQueuePosition,
  getWorkItemCore,
  type ReviewQueuePosition,
} from "../workItemStateRepository.js";
import { closeReviewVerdictsForWorkItems, reviewVerdict } from "../reviewVerdict.js";
import { loadRenderableHeadCi, requestHeadCiProjection } from "../ciProjection.js";
import { parseProgressRevisionState } from "../../review/run/commentMarkers.js";
import {
  renderReviewCancelledNotice,
  renderReviewAwaitingApprovalNotice,
  renderReviewProgressComment,
} from "../../review/run/progressComment.js";
import type { ReviewMode } from "../../review/reviewSchema.js";
import { ACTIVE_WORK_STATUSES, prResourceKey, type AckJobData } from "../types.js";
import { canPublishApprovalNotice } from "../intake/reviewApprovals.js";
import { errorMessage } from "../../errors/errorMessage.js";
import {
  capabilityObservationUnconfirmed,
  createReviewCapabilityPolicy,
  unknownInstallationCapabilities,
  type InstallationCapabilities,
  type ReviewCapabilityPolicy,
} from "../../github/installationCapabilities.js";
import {
  loadGithubCapabilityObservation,
  nextGithubCapabilityObservationGeneration,
  recordGithubCapabilityDenial,
  saveGithubCapabilityObservation,
} from "../githubCapabilityRepository.js";

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
  if (workItem == null || !(ACTIVE_WORK_STATUSES as readonly string[]).includes(workItem.status)) {
    return false;
  }
  const owner = await getProgressCommentOwner(pool, params.resourceKey, params.reviewLens);
  if (owner != null && owner.workItemId !== params.workItemId) {
    return false;
  }
  return true;
}

type AckInstallation = Awaited<ReturnType<typeof productionInstallationSurface.token>>;

async function ackPrSurface(
  cfg: Config,
  data: Pick<AckJobData, "installationId" | "owner" | "repo" | "prNumber">,
  installation: AckInstallation,
  capabilities?: ReviewCapabilityPolicy,
) {
  return productionInstallationSurface.create({
    cfg,
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    installation,
    capabilities,
    mutationBoundary: unfencedSurface(),
  });
}

async function publishAckProgress(
  cfg: Config,
  pool: Pool,
  data: AckJobData & { readonly progress: NonNullable<AckJobData["progress"]> },
  installation: AckInstallation,
  resourceKey: string,
  boss?: PgBoss,
  capabilities?: ReviewCapabilityPolicy,
): Promise<void> {
  const prSurface = await ackPrSurface(cfg, data, installation, capabilities);
  if ((prSurface.capabilities?.access("commentsWrite") ?? "available") !== "available") return;
  const deferredHead = data.progress.headSha === DEFERRED_HEAD_SHA;
  const headSha = deferredHead ? await prSurface.getHeadSha() : data.progress.headSha;
  const rendered = await loadRenderableHeadCi(
    pool,
    data.owner,
    data.repo,
    headSha,
    data.installationId,
  );
  const ciSummary = rendered.summary;
  let queuePosition: ReviewQueuePosition | null = null;
  if (data.workItemId != null) {
    try {
      queuePosition = await getReviewQueuePosition(pool, data.workItemId);
    } catch (e) {
      logWarn("ack_queue_position_failed", {
        workItemId: data.workItemId,
        message: errorMessage(e),
      });
    }
  }
  // Queued stub: Head/Source/(Queue)/(CI) only — no Recon/specialist rows until the review worker starts.
  const body = renderReviewProgressComment({
    mode: data.progress.lens,
    headSha,
    source: data.progress.source,
    ciSummary,
    ciVersion: rendered.version,
    queuePosition,
    progressRevision: 0,
    progressWorkItemId: data.workItemId,
  });
  await createReviewSummaryComment({
    prSurface,
    reviewLens: data.progress.lens,
    coordination: { pool, resourceKey, workItemId: data.workItemId },
  }).tick({
    body,
    progressRevision: 0,
    ciHeadSha: headSha,
    ciVersion: rendered.version,
  });
  await requestHeadCiProjection(
    boss,
    { installationId: data.installationId, owner: data.owner, repo: data.repo, headSha },
    { kind: "when_due", pool, renderedVersion: rendered.version },
  );
  // Deferred-head reviews resolve the binding head at claim time; starting the
  // check run here would pin it to an earlier SHA if another push lands first.
  if (data.workItemId && !deferredHead) {
    await reviewVerdict({
      pool,
      commitStatusEnabled: cfg.features.commitStatus,
      summaryCommentId: null,
      prSurface,
      owner: data.owner,
      repo: data.repo,
      prNumber: data.prNumber,
      headSha,
      workItemId: data.workItemId,
      resourceKey,
      reviewLens: data.progress.lens,
    }).pending();
  }
}

async function publishCancelProgress(
  cfg: Config,
  pool: Pool,
  data: AckJobData & { readonly cancelProgress: NonNullable<AckJobData["cancelProgress"]> },
  installation: AckInstallation,
  resourceKey: string,
  capabilities?: ReviewCapabilityPolicy,
): Promise<void> {
  const prSurface = await ackPrSurface(cfg, data, installation, capabilities);
  const commentsAvailable =
    (prSurface.capabilities?.access("commentsWrite") ?? "available") === "available";
  const existing = commentsAvailable
    ? await prSurface.findProgressComment(REVIEW_SUMMARY_SENTINEL)
    : null;
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
    if (!commentsAvailable) {
      // Verdict receipts remain applicable even when a cancellation notice cannot be written.
    } else if (ownsStub && existing != null) {
      await prSurface.editComment(existing.id, body);
    } else {
      await createReviewSummaryComment({
        prSurface,
        reviewLens: "review",
        coordination: { pool, resourceKey, workItemId: data.cancelProgress.workItemId },
      }).tick({ body, progressRevision: 0 });
    }
  } catch (error) {
    logWarn("ack_cancel_comment_failed", {
      workItemId: data.cancelProgress.workItemId,
      resourceKey,
      message: errorMessage(error),
    });
  }

  // Stale pre-deploy ack jobs may omit cancelledWorkItemIds; fall back to the primary id.
  const cancelledWorkItemIds = data.cancelProgress.cancelledWorkItemIds ?? [
    data.cancelProgress.workItemId,
  ];

  await closeReviewVerdictsForWorkItems(pool, {
    prSurface,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    workItemIds: cancelledWorkItemIds,
    commitStatusEnabled: cfg.features.commitStatus,
    outcome: { kind: "cancelled" },
  });
}

async function publishTriageCancellation(
  prSurface: Awaited<ReturnType<typeof ackPrSurface>>,
  data: AckJobData & { readonly cancelTriage: NonNullable<AckJobData["cancelTriage"]> },
): Promise<void> {
  if ((prSurface.capabilities?.access("reactionsWrite") ?? "available") === "available") {
    await prSurface.setAcknowledgementReaction(
      data.cancelTriage.targets,
      GITHUB_REACTION_MINUS_ONE,
    );
  }
  if ((prSurface.capabilities?.access("commentsWrite") ?? "available") === "available") {
    await prSurface.replyAt(
      data.cancelTriage.replyTarget,
      triageCancelledNotice(data.cancelTriage.attribution),
    );
  }
}

/** Fire-and-forget ack (reactions, progress stub, slash replies); not a durable work item. */
export async function executeAckJob(
  cfg: Config,
  pool: Pool,
  data: AckJobData,
  boss?: PgBoss,
): Promise<void> {
  try {
    const bot = await productionInstallationSurface.botIdentity(cfg);
    if (data.commenterId != null && bot.userId === data.commenterId) return;
  } catch (e) {
    logWarn("ack_bot_identity_check_failed", {
      message: errorMessage(e),
    });
  }
  const scope = { installationId: data.installationId, owner: data.owner, repo: data.repo };
  const stored = await loadGithubCapabilityObservation(pool, scope);
  let observation: InstallationCapabilities;
  let installation: AckInstallation | undefined;
  if (stored && !capabilityObservationUnconfirmed(stored.capabilities)) {
    const unknown = unknownInstallationCapabilities(
      { ...scope, appId: cfg.github.appId },
      String(stored.generation),
    );
    observation = { ...unknown, availability: { ...unknown.availability, ...stored.capabilities } };
    installation = await productionInstallationSurface.token(cfg, data.installationId);
  } else {
    const fresh = await productionInstallationSurface.preflight({
      cfg,
      ...scope,
      generation: await nextGithubCapabilityObservationGeneration(pool),
    });
    observation = fresh.observation;
    installation = fresh.installation;
    await saveGithubCapabilityObservation(pool, { ...scope, observation });
    if (!installation) return;
  }
  const capabilities = createReviewCapabilityPolicy(observation, async (operation) => {
    await recordGithubCapabilityDenial(pool, {
      ...scope,
      generation: Number(observation.generation),
      operation,
    });
  });
  const prSurface = await ackPrSurface(cfg, data, installation, capabilities);
  const resourceKey = prResourceKey(data.owner, data.repo, data.prNumber);

  if (!data.awaitingApproval && !data.closedApproval) {
    await reactBestEffort(prSurface, data.targets, GITHUB_REACTION_EYES);
  }

  if (
    (data.awaitingApproval || data.closedApproval) &&
    (prSurface.capabilities?.access("commentsWrite") ?? "available") === "available"
  ) {
    await createReviewSummaryComment({
      prSurface,
      reviewLens: "review",
      coordination: { pool, resourceKey },
    }).tick({
      body: data.closedApproval
        ? renderReviewCancelledNotice({ attribution: data.closedApproval, progressRevision: 1 })
        : renderReviewAwaitingApprovalNotice(),
      progressRevision: data.closedApproval ? 1 : 0,
      shouldPublish: (client) =>
        canPublishApprovalNotice(
          client,
          resourceKey,
          data.closedApproval ? "withdrawn" : "awaiting",
        ),
    });
  }

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
        capabilities,
      );
    } catch (error) {
      logWarn("ack_cancel_progress_failed", {
        workItemId: data.cancelProgress.workItemId,
        resourceKey,
        message: errorMessage(error),
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
        message: errorMessage(error),
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
        await publishAckProgress(
          cfg,
          pool,
          progressData,
          installation,
          resourceKey,
          boss,
          capabilities,
        );
      }
    } else {
      await publishAckProgress(
        cfg,
        pool,
        progressData,
        installation,
        resourceKey,
        boss,
        capabilities,
      );
    }
  }

  if (
    data.reply &&
    (prSurface.capabilities?.access("commentsWrite") ?? "available") === "available"
  ) {
    await prSurface.replyAt(data.reply.target, data.reply.body);
  }

  // Ack-only interactions (help / disabled / usage / cancel) finish here — no durable work item.
  if (data.reply && data.workItemId == null) {
    await reactBestEffort(prSurface, data.targets, GITHUB_REACTION_PLUS_ONE);
  }
}

/** A reaction never blocks the replies and progress that follow it in the same job. */
async function reactBestEffort(
  prSurface: Awaited<ReturnType<typeof ackPrSurface>>,
  targets: AckJobData["targets"],
  reaction: GithubReactionContent,
): Promise<void> {
  if ((prSurface.capabilities?.access("reactionsWrite") ?? "available") !== "available") return;
  try {
    await prSurface.setAcknowledgementReaction(targets, reaction);
  } catch (error) {
    logWarn("ack_reaction_failed", { reaction, message: errorMessage(error) });
  }
}
