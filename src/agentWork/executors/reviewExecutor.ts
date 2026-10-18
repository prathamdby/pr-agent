import type { WorkExecution, WorkExecutionDependencies } from "../workDefinition.ts";
import { productionInstallationSurface } from "../installationSurface.ts";
import { createPublishContext } from "../publishOnce.ts";
import { createFeaturePiSession } from "../../agent/runtime/createFeatureSession.ts";
import { createReviewSummaryComment } from "../../review/publish/reviewSummaryComment.ts";
import { renderFailureNoticeWithFindings } from "../../review/run/reviewRunFallback.ts";
import { loadFindingInventoryOrUnavailable } from "../../review/findingIdentity/findingInventory.ts";
import { buildFindingView } from "../../review/findingIdentity/findingLifecycle.ts";
import { runReviewForWorkItem } from "../../review/runReviewForWorkItem.ts";
import { isOwnCheckOpen, ownVerdictFromSummaryDetail, reviewVerdict } from "../reviewVerdict.ts";
import { getProgressCommentOwner } from "../publishRecordRepository.ts";
import { cancelPendingStaleHeadReplacement } from "../reviewReschedule.ts";
import { isAppError } from "../../errors/appError.ts";

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
      } catch {}
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
      let commentId: number | null = null;
      if (weOwnStub) {
        const accessSuffix =
          isAppError(error) && error.code === "github.essential_access_denied"
            ? "\n\nGitHub installation access is missing for this review. Restore the repository grants, then run `/review`."
            : "";
        const findingView = buildFindingView(
          await loadFindingInventoryOrUnavailable(prSurface, {
            renames: new Map(),
            deletedPaths: new Set(),
          }),
          { kind: "not_reviewed" },
        );
        const notice = `${renderFailureNoticeWithFindings(reviewLens, findingView, accessSuffix.length)}${accessSuffix}`;
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
