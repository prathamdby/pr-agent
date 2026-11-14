import type { Pool } from "pg";
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
import type { Config } from "../settings/index.ts";
import type { GithubReviewEvent } from "./reviewVerdict.ts";
import { getActiveReviewWorkItem } from "./workItemStateRepository.ts";

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
}): Promise<void> {
  const { prSurface, pool, resourceKey, workItemId } = params;
  const skip = (reason: string) =>
    logInfo("verification_review_verdict_skipped", { workItemId, resourceKey, reason });
  try {
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
    });
  } catch (error) {
    logWarn("verification_review_verdict_failed", {
      workItemId,
      resourceKey,
      message: errorMessage(error),
    });
  }
}
