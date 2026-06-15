import type { Pool } from "pg";
import type { Config } from "../../config.js";
import {
  resolveVerifiedSummaryCommentRef,
  upsertReviewSummaryComment,
} from "../../github/reviewPublish.js";
import { logDebug, logWarn } from "../../evlog.js";
import { reviewSummarySentinelForMode } from "../../review/reviewSchema.js";
import { upsertSummaryCommentWithCreationClaim } from "../../review/publish/publishReview.js";
import { DEFERRED_HEAD_SHA } from "../../settings/index.js";
import { mintInstallationToken } from "../durableJob.js";
import { getSummaryCommentGithubId, recordPublishStep } from "../repository.js";
import { renderReviewProgressComment } from "../../review/run/progressComment.js";
import {
  getAppBotIdentity,
  getPullRequestHeadSha,
  postAckReply,
  safeReaction,
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

  await Promise.all(
    data.targets.map(async (target) => {
      try {
        await safeReaction(
          installation.token,
          data.owner,
          data.repo,
          target,
          installation.expiresAtTs,
        );
      } catch (e) {
        logDebug("ack_reaction_failed", {
          owner: data.owner,
          repo: data.repo,
          targetKind: target.kind,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }),
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
    const body = renderReviewProgressComment({
      mode: data.progress.lens,
      headSha,
      source: data.progress.source,
    });
    const resourceKey = `${data.owner}/${data.repo}#${data.prNumber}`;
    const sentinel = reviewSummarySentinelForMode(data.progress.lens);
    let summary;
    if (data.workItemId) {
      summary = await upsertSummaryCommentWithCreationClaim({
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
      });
    } else {
      const storedId = await getSummaryCommentGithubId(pool, resourceKey, data.progress.lens);
      const verified =
        storedId != null
          ? await resolveVerifiedSummaryCommentRef(
              installation.token,
              data.owner,
              data.repo,
              data.prNumber,
              sentinel,
              storedId,
              installation.expiresAtTs,
            )
          : null;
      summary = await upsertReviewSummaryComment(
        installation.token,
        data.owner,
        data.repo,
        data.prNumber,
        body,
        sentinel,
        verified ? { id: verified.id, url: verified.url } : undefined,
        installation.expiresAtTs,
      );
    }
    if (data.workItemId) {
      await recordPublishStep(pool, {
        workItemId: data.workItemId,
        resourceKey: `${data.owner}/${data.repo}#${data.prNumber}`,
        reviewLens: data.progress.lens,
        step: "progress_comment",
        githubId: summary.id,
        detail: { updated: summary.updated },
      });
    }
  }

  if (data.reply) {
    await postAckReply(installation.token, data, data.reply.body, installation.expiresAtTs);
  }
}
