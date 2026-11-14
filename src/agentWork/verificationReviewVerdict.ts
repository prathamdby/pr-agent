import type { Pool } from "pg";
import { isAppError } from "../errors/appError.ts";
import { errorMessage } from "../errors/errorMessage.ts";
import { logInfo, logWarn } from "../evlog.ts";
import type { PrSurface } from "../github/prSurface.ts";
import { loadFindingInventory } from "../review/findingIdentity/findingInventory.ts";
import {
  buildFindingView,
  findingCheck,
  type FindingCheck,
} from "../review/findingIdentity/findingLifecycle.ts";
import { publishReviewVerdictEvent } from "../review/publish/publishCloseOutcomeReview.ts";
import { threadMutationLock } from "../review/findingIdentity/threadMutationLock.ts";
import type { Config } from "../settings/index.ts";
import type { GithubReviewEvent } from "./reviewVerdict.ts";
import { getActiveReviewWorkItem } from "./workItemStateRepository.ts";
import type { VerificationDegradationReason } from "./verificationPublishGate.ts";

export function verificationReviewEvent(
  check: FindingCheck,
  standing: "APPROVED" | "CHANGES_REQUESTED" | undefined,
): GithubReviewEvent | undefined {
  if (check.conclusion === "success" && standing === "CHANGES_REQUESTED") return "APPROVE";
  if (check.conclusion === "failure" && standing === "APPROVED") return "REQUEST_CHANGES";
  return undefined;
}

export async function refreshReviewVerdictAfterVerification(params: {
  readonly cfg: Config;
  readonly pool: Pool;
  readonly prSurface: PrSurface;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly headSha: string;
  readonly leaseEpoch: number | null;
  readonly canPublish: () => Promise<boolean>;
  readonly degradation: readonly VerificationDegradationReason[];
}): Promise<void> {
  const { prSurface, pool, resourceKey, workItemId } = params;
  const skip = (reason: string) =>
    logInfo("verification_review_verdict_skipped", { workItemId, resourceKey, reason });
  try {
    if (params.degradation.length > 0) {
      logInfo("verification_review_verdict_skipped", {
        workItemId,
        resourceKey,
        reason: "verification_degraded",
        degradation: params.degradation,
      });
      return;
    }
    await threadMutationLock(
      pool,
      resourceKey,
    )(async () => {
      if (!(await params.canPublish())) return;
      if (await getActiveReviewWorkItem(pool, resourceKey)) {
        skip("active_review");
        return;
      }
      const inventory = await loadFindingInventory(prSurface, {
        renames: new Map(),
        deletedPaths: new Set(),
      });
      const check = findingCheck(
        buildFindingView(inventory, { kind: "not_reviewed" }, params.cfg.review.checkFailSeverity),
      );
      if (check.conclusion === "neutral") {
        skip(`inventory_${inventory.completeness}`);
        return;
      }
      const botLogin = await prSurface.getBotLogin();
      const reviews = await prSurface.listPullRequestReviews();
      const standing = reviews.findLast(
        (review) =>
          review.authorLogin === botLogin &&
          (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED"),
      )?.state;
      const event = verificationReviewEvent(
        check,
        standing === "APPROVED" || standing === "CHANGES_REQUESTED" ? standing : undefined,
      );
      if (event == null) return;
      if (!(await params.canPublish())) return;
      if (await getActiveReviewWorkItem(pool, resourceKey)) {
        skip("active_review");
        return;
      }
      await publishReviewVerdictEvent({
        prSurface,
        event,
        headSha: params.headSha,
        workItemId,
        pool,
        leaseEpoch: params.leaseEpoch,
        operationKey: `verification:verdict_review:${workItemId}:${params.headSha}:${event}`,
      });
    });
  } catch (error) {
    if (isAppError(error) && error.code === "agent_work.thread_mutation_lock_timeout") {
      skip(error.code);
      return;
    }
    logWarn("verification_review_verdict_failed", {
      workItemId,
      resourceKey,
      message: errorMessage(error),
    });
  }
}
