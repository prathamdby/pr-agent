import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.js";
import { productionInstallationSurface } from "../installationSurface.js";
import { createPublishContext } from "../publishOnce.js";
import { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.js";
import { createReviewSummaryComment } from "../../review/publish/reviewSummaryComment.js";
import { renderReviewFailureNotice } from "../../review/run/progressComment.js";
import { runReviewForWorkItem } from "../../review/runReviewForWorkItem.js";
import { isOwnCheckOpen, ownVerdictFromSummaryDetail, reviewVerdict } from "../reviewVerdict.js";
import { getProgressCommentOwner } from "../publishRecordRepository.js";
import { cancelPendingStaleHeadReplacement } from "../reviewReschedule.js";
import { isAppError } from "../../errors/appError.js";

export function createReviewWorkExecution({
  cfg,
  pool,
  boss,
  installationSurface = productionInstallationSurface,
  createSession = createFeaturePiSession,
}: WorkExecutionDependencies): WorkExecution<"review"> {
  const getBotIdentity = () => installationSurface.botIdentity(cfg);
  return {
    execute: (item, env) =>
      runReviewForWorkItem(item, env, { cfg, pool, boss, getBotIdentity, createSession }),
    onCancelled: async (item, prSurface, _reason, leaseEpoch) => {
      if (!item.reviewLens) return;
      const reviewLens = item.reviewLens;
      await reviewVerdict({
        pool,
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        headSha: item.headSha,
        leaseEpoch,
        commitStatusEnabled: cfg.features.commitStatus,
      }).close({ kind: "cancelled" });
    },
    onTerminalFailure: async (item, prSurface, error, leaseEpoch) => {
      try {
        await cancelPendingStaleHeadReplacement(pool, item, error);
      } catch {
        // Already logged at error level as agent_work_replacement_cancel_failed; the
        // verdict close below must still run.
      }
      if (!prSurface) return;
      const reviewLens = item.reviewLens;
      if (!reviewLens) return;
      const summaryDetail = await createPublishContext(pool, {
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens: reviewLens,
      }).completed("summary_comment");
      const checkDetail = await createPublishContext(pool, {
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens: reviewLens,
      }).completed("check_run");
      if (summaryDetail != null) {
        if (!isOwnCheckOpen(checkDetail)) return;
        await reviewVerdict({
          pool,
          prSurface,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          headSha: item.headSha,
          leaseEpoch,
          commitStatusEnabled: cfg.features.commitStatus,
        }).close(ownVerdictFromSummaryDetail(summaryDetail));
        return;
      }
      if ((prSurface.capabilities?.access("commentsWrite") ?? "available") !== "available") {
        await reviewVerdict({
          pool,
          prSurface,
          owner: item.owner,
          repo: item.repo,
          prNumber: item.prNumber,
          workItemId: item.id,
          resourceKey: item.resourceKey,
          reviewLens,
          headSha: item.headSha,
          leaseEpoch,
          commitStatusEnabled: cfg.features.commitStatus,
        }).close({ kind: "crashed" });
        return;
      }
      const owner = await getProgressCommentOwner(pool, item.resourceKey, reviewLens);
      const weOwnStub = owner == null || owner.workItemId === item.id;
      const failureNotice = renderReviewFailureNotice({
        mode: reviewLens,
        retryCommand: "/review",
      });
      const notice =
        isAppError(error) && error.code === "github.essential_access_denied"
          ? `${failureNotice}\n\nGitHub installation access is missing for this review. Restore the repository grants, then run \`/review\`.`
          : failureNotice;
      let commentId: number | null = null;
      if (weOwnStub) {
        const summary = await createReviewSummaryComment({
          prSurface,
          reviewLens,
          coordination: {
            pool,
            resourceKey: item.resourceKey,
            workItemId: item.id,
            leaseEpoch,
          },
        }).conclude({ body: notice });
        commentId = summary.id > 0 ? summary.id : null;
      }
      await reviewVerdict({
        pool,
        prSurface,
        owner: item.owner,
        repo: item.repo,
        prNumber: item.prNumber,
        workItemId: item.id,
        resourceKey: item.resourceKey,
        reviewLens,
        headSha: item.headSha,
        leaseEpoch,
        commitStatusEnabled: cfg.features.commitStatus,
        summaryCommentId: commentId,
      }).close({ kind: "crashed" });
    },
  };
}
