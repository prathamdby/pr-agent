import type { Pool } from "pg";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { reviewSummarySentinelForMode } from "../../review/reviewSchema.js";
import { upsertSummaryCommentWithCreationClaim } from "../../review/publish/publishReview.js";
import {
  DEFERRED_HEAD_SHA,
  GITHUB_REACTION_EYES,
  GITHUB_REACTION_PLUS_ONE,
} from "../../settings/index.js";
import { mintInstallationToken } from "../durableJob.js";
import { ensureReviewCheckRunStarted } from "../reviewCheckRun.js";
import { buildCiSummary } from "../../review/ci/analyzeCi.js";
import {
  initialProgressTickState,
  renderReviewProgressComment,
} from "../../review/run/progressComment.js";
import {
  getAppBotIdentity,
  getPullRequestHeadSha,
  postAckReply,
  reactOnAckTargets,
} from "../githubPrSurface.js";
import type { AckJobData } from "../types.js";

/** Fire-and-forget ack (reactions, progress stub, slash replies); not a durable work item. */
export async function executeAckJob(cfg: Config, pool: Pool, data: AckJobData): Promise<void> {
  if (data.commenterId != null) {
    try {
      const bot = await getAppBotIdentity(cfg);
      if (bot.userId === data.commenterId) return;
    } catch (e) {
      logWarn("ack_bot_identity_check_failed", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const installation = await mintInstallationToken(cfg, data.installationId);

  await reactOnAckTargets(
    installation.token,
    data.owner,
    data.repo,
    data.targets,
    GITHUB_REACTION_EYES,
    installation.expiresAtTs,
  );

  if (data.progress) {
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
    const body = renderReviewProgressComment({
      mode: data.progress.lens,
      headSha,
      source: data.progress.source,
      ciSummary,
      tickState: initialProgressTickState(),
      progressRevision: 0,
      progressWorkItemId: data.workItemId,
    });
    const resourceKey = `${data.owner}/${data.repo}#${data.prNumber}`;
    const sentinel = reviewSummarySentinelForMode(data.progress.lens);
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
      sentinel,
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
        resourceKey: `${data.owner}/${data.repo}#${data.prNumber}`,
        reviewLens: data.progress.lens,
      });
    }
  }

  if (data.reply) {
    await postAckReply(installation.token, data, data.reply.body, installation.expiresAtTs);
  }

  // Ack-only interactions (help / disabled / usage) finish here — no durable work item.
  if (data.reply && data.workItemId == null) {
    await reactOnAckTargets(
      installation.token,
      data.owner,
      data.repo,
      data.targets,
      GITHUB_REACTION_PLUS_ONE,
      installation.expiresAtTs,
    );
  }
}
