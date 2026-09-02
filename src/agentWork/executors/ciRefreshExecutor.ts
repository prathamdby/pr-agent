import type { Config } from "../../config.js";
import type { Pool } from "pg";
import { logDebug, logWarn } from "../../evlog.js";
import { buildCiSummaryForSurface } from "../../review/ci/analyzeCi.js";
import { createAgentCiSummaryAuthor } from "../../review/ci/authorCiSummary.js";
import {
  commentBodyHasCiSummaryCell,
  patchCiSummaryCellInCommentBody,
  shouldRenderCiSummaryRow,
} from "../../review/ci/renderCiSummary.js";
import { parseReviewMetaFromCommentBody } from "../../review/ci/reviewMetaParse.js";
import { REVIEW_CI_SUMMARY_MAX_FAILURES, REVIEW_SUMMARY_SENTINEL } from "../../settings/index.js";
import { LEGACY_REVIEW_SUMMARY_SENTINELS } from "../../settings/legacyReviewLenses.js";
import { createPrSurface } from "../../github/prSurface.js";
import { mintInstallationToken } from "../durableJob.js";
import { hasActiveReviewWorkItem } from "../repository.js";
import type { CiRefreshJobData } from "../types.js";
import { prResourceKey } from "../types.js";

const SUMMARY_SENTINELS = [REVIEW_SUMMARY_SENTINEL, ...LEGACY_REVIEW_SUMMARY_SENTINELS] as const;

/**
 * Refreshes the CI cell on matching review summary comments for a head SHA after
 * workflow_run / check_suite completed. Does not re-run the review agent.
 */
export async function executeCiRefreshJob(
  cfg: Config,
  pool: Pool,
  data: CiRefreshJobData,
): Promise<void> {
  const installation = await mintInstallationToken(cfg, data.installationId);
  if (await hasActiveReviewWorkItem(pool, prResourceKey(data.owner, data.repo, data.prNumber))) {
    logDebug("ci_refresh_skipped_active_review", {
      owner: data.owner,
      repo: data.repo,
      pr: data.prNumber,
    });
    return;
  }
  const prSurface = createPrSurface({
    cfg,
    installationId: data.installationId,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    installation,
  });
  const author = createAgentCiSummaryAuthor(cfg);

  const ciSummary = await buildCiSummaryForSurface(prSurface, {
    headSha: data.headSha,
    waitMs: 0,
    maxFailures: REVIEW_CI_SUMMARY_MAX_FAILURES,
    author,
  });

  if (!shouldRenderCiSummaryRow(ciSummary)) {
    logDebug("ci_refresh_skipped_unrenderable", {
      owner: data.owner,
      repo: data.repo,
      pr: data.prNumber,
      status: ciSummary.status,
    });
    return;
  }

  const conversationComments = await prSurface.listConversationComments();

  for (const sentinel of SUMMARY_SENTINELS) {
    try {
      const comment = conversationComments.findLast((c) => (c.body ?? "").startsWith(sentinel));
      if (comment == null) continue;

      const meta = parseReviewMetaFromCommentBody(comment.body ?? "");
      if (meta == null || meta.headSha !== data.headSha) continue;
      if (!commentBodyHasCiSummaryCell(comment.body ?? "")) continue;

      const patched = patchCiSummaryCellInCommentBody(comment.body ?? "", ciSummary);
      if (patched == null || patched === comment.body) continue;

      await prSurface.editComment(comment.id, patched);
      logDebug("ci_refresh_patched", {
        owner: data.owner,
        repo: data.repo,
        pr: data.prNumber,
        commentId: comment.id,
        status: ciSummary.status,
      });
    } catch (error) {
      logWarn("ci_refresh_comment_failed", {
        owner: data.owner,
        repo: data.repo,
        pr: data.prNumber,
        sentinel,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
