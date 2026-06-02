import type { Pool } from "pg";
import type { Config } from "../../config.js";
import { upsertReviewSummaryComment } from "../../github/reviewPublish.js";
import { logDebug, logWarn } from "../../evlog.js";
import { reviewSummarySentinelForMode } from "../../review/reviewSchema.js";
import { DEFERRED_HEAD_SHA } from "../../settings/index.js";
import { mintInstallationToken } from "../durableJob.js";
import { recordPublishStep } from "../repository.js";
import { renderReviewProgressComment } from "../../review/progressComment.js";
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

  for (const target of data.targets) {
    try {
      await safeReaction(installation.token, data.owner, data.repo, target);
    } catch (e) {
      logDebug("ack_reaction_failed", {
        owner: data.owner,
        repo: data.repo,
        targetKind: target.kind,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (data.progress) {
    const headSha =
      data.progress.headSha === DEFERRED_HEAD_SHA
        ? await getPullRequestHeadSha(installation.token, data.owner, data.repo, data.prNumber)
        : data.progress.headSha;
    const body = renderReviewProgressComment({
      mode: data.progress.lens,
      headSha,
      source: data.progress.source,
    });
    const summary = await upsertReviewSummaryComment(
      installation.token,
      data.owner,
      data.repo,
      data.prNumber,
      body,
      reviewSummarySentinelForMode(data.progress.lens),
    );
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
    await postAckReply(installation.token, data, data.reply.body);
  }
}
