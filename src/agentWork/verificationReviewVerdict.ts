import type { Pool } from "pg";
import { isAppError } from "../errors/appError.ts";
import { errorMessage } from "../errors/errorMessage.ts";
import { logInfo, logWarn } from "../evlog.ts";
import type { PrSurface } from "../github/prSurface.ts";
import {
  loadFindingInventory,
  type FindingInventory,
} from "../review/findingIdentity/findingInventory.ts";
import {
  buildFindingView,
  findingCheck,
  type FindingCheck,
} from "../review/findingIdentity/findingLifecycle.ts";
import { publishReviewVerdictEvent } from "../review/publish/publishCloseOutcomeReview.ts";
import { threadMutationLock } from "../review/findingIdentity/threadMutationLock.ts";
import { isCheckFailingSeverity } from "../review/reviewSchema.ts";
import type { Config } from "../settings/index.ts";
import type { GithubReviewEvent } from "./reviewVerdict.ts";
import { getActiveReviewWorkItem } from "./workItemStateRepository.ts";
import type { VerificationDegradationReason } from "./verificationPublishGate.ts";

export function verificationReviewEvent(
  check: FindingCheck,
  standing: "APPROVED" | "CHANGES_REQUESTED" | undefined,
) {
  if (check.conclusion === "success" && standing === "CHANGES_REQUESTED")
    return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("APPROVE");
  if (check.conclusion === "failure" && standing === "APPROVED")
    return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)("REQUEST_CHANGES");
  return ((pinnedReturn: GithubReviewEvent | undefined) => pinnedReturn)(undefined);
}

const DEGRADED_APPROVE_REASONS = new Set<VerificationDegradationReason>([
  "compare_files_truncated",
  "inventory_narrowed",
  "objection_answers_capped",
  "objection_detection_incomplete",
]);

function everyOwnedReviewThreadResolved(inventory: FindingInventory) {
  for (const finding of inventory.findings.values()) {
    if (finding.source === "thread" && finding.state === "open")
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  for (const copy of inventory.sameIdCopies) {
    if (copy.source === "thread" && copy.state === "open")
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(true);
}

function openSameIdCopyBlocks(
  inventory: FindingInventory,
  checkFailSeverity: Config["review"]["checkFailSeverity"],
) {
  for (const copy of inventory.sameIdCopies) {
    if (copy.state !== "open" || copy.source !== "thread" || copy.severity === "unknown") continue;
    if (isCheckFailingSeverity(copy.severity, checkFailSeverity))
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(false);
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
}) {
  const { prSurface, pool, resourceKey, workItemId } = params;
  const skip = (reason: string) =>
    logInfo("verification_review_verdict_skipped", { workItemId, resourceKey, reason });
  try {
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
      const conclusion = openSameIdCopyBlocks(inventory, params.cfg.review.checkFailSeverity)
        ? "failure"
        : check.conclusion;
      if (conclusion === "neutral") {
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
        { conclusion, blockingCount: check.blockingCount },
        standing === "APPROVED" || standing === "CHANGES_REQUESTED" ? standing : undefined,
      );
      const degradedApprove =
        event === "APPROVE" &&
        everyOwnedReviewThreadResolved(inventory) &&
        params.degradation.every((reason) => DEGRADED_APPROVE_REASONS.has(reason));
      const degradedRequestChanges =
        event === "REQUEST_CHANGES" &&
        params.degradation.every((reason) => reason === "thread_resolution_degraded");
      if (params.degradation.length > 0 && !degradedApprove && !degradedRequestChanges) {
        logInfo("verification_review_verdict_skipped", {
          workItemId,
          resourceKey,
          reason: "verification_degraded",
          degradation: params.degradation,
        });
        return;
      }
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
