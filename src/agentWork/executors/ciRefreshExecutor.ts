import type { Config } from "../../config.js";
import {
  findIssueCommentWithBodyBySentinel,
  updateIssueComment,
} from "../../github/reviewPublish.js";
import { logDebug, logWarn } from "../../evlog.js";
import { buildCiSummary } from "../../review/ci/analyzeCi.js";
import { createAgentCiSummaryAuthor } from "../../review/ci/authorCiSummary.js";
import {
  commentBodyHasCiSummaryCell,
  patchCiSummaryCellInCommentBody,
  shouldRenderCiSummaryRow,
} from "../../review/ci/renderCiSummary.js";
import { parseReviewMetaFromCommentBody } from "../../review/ci/reviewMetaParse.js";
import {
  QUALITY_REVIEW_SUMMARY_SENTINEL,
  REVIEW_CI_SUMMARY_MAX_FAILURES,
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  TESTS_REVIEW_SUMMARY_SENTINEL,
} from "../../settings/index.js";
import { mintInstallationToken } from "../durableJob.js";
import type { CiRefreshJobData } from "../types.js";

const SUMMARY_SENTINELS = [
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  QUALITY_REVIEW_SUMMARY_SENTINEL,
  TESTS_REVIEW_SUMMARY_SENTINEL,
] as const;

/**
 * Refreshes the CI cell on matching review summary comments for a head SHA after
 * workflow_run completed. Does not re-run the review agent.
 */
export async function executeCiRefreshJob(cfg: Config, data: CiRefreshJobData): Promise<void> {
  const installation = await mintInstallationToken(cfg, data.installationId);
  const author = createAgentCiSummaryAuthor(cfg);

  const ciSummary = await buildCiSummary({
    token: installation.token,
    owner: data.owner,
    repo: data.repo,
    headSha: data.headSha,
    expiresAtTs: installation.expiresAtTs,
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

  for (const sentinel of SUMMARY_SENTINELS) {
    try {
      const comment = await findIssueCommentWithBodyBySentinel(
        installation.token,
        data.owner,
        data.repo,
        data.prNumber,
        sentinel,
        installation.expiresAtTs,
      );
      if (comment == null) continue;

      const meta = parseReviewMetaFromCommentBody(comment.body);
      if (meta == null || meta.headSha !== data.headSha) continue;
      if (!commentBodyHasCiSummaryCell(comment.body)) continue;

      const patched = patchCiSummaryCellInCommentBody(comment.body, ciSummary);
      if (patched == null || patched === comment.body) continue;

      await updateIssueCommentBody(
        installation.token,
        data.owner,
        data.repo,
        comment.id,
        patched,
        installation.expiresAtTs,
      );
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
