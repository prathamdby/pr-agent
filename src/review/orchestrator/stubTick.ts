import type { Pool } from "pg";
import type { Config } from "../../config.js";
import { logWarn } from "../../evlog.js";
import { reviewSummarySentinelForMode, type WorkSource } from "../reviewSchema.js";
import { upsertSummaryCommentWithCreationClaim } from "../publish/summaryCommentCoordination.js";
import {
  renderReviewProgressComment,
  type ProgressRunPhase,
  type SpecialistTickState,
} from "../run/progressComment.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { refreshInstallationTokenIfNearExpiry } from "./refreshInstallationTokenIfNearExpiry.js";

export type TickProgressCommentArgs = {
  cfg: Pick<Config, "piModel" | "features">;
  pool: Pool;
  workItemId: string;
  resourceKey: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  source: WorkSource;
  getToken: () => string;
  getTokenExpiresAtTs?: () => number | undefined;
  refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  specialistTicks: SpecialistTickState;
  runPhase?: ProgressRunPhase;
  ciSummary?: CiSummary | null;
  summaryCommentIdHint?: number | null;
};

/**
 * Best-effort specialist progress tick: re-render the review progress comment and upsert
 * in place. Failures log a warning and never fail the review run.
 */
export async function tickProgressComment(args: TickProgressCommentArgs): Promise<void> {
  try {
    await refreshInstallationTokenIfNearExpiry({
      getTokenExpiresAtTs: args.getTokenExpiresAtTs,
      refreshInstallationToken: args.refreshInstallationToken,
    });

    const body = renderReviewProgressComment({
      mode: "review",
      headSha: args.headSha,
      source: args.source,
      ciSummary: args.ciSummary,
      specialistTicks: args.specialistTicks,
      runPhase: args.runPhase,
    });

    await upsertSummaryCommentWithCreationClaim({
      pool: args.pool,
      workItemId: args.workItemId,
      resourceKey: args.resourceKey,
      reviewLens: "review",
      token: args.getToken(),
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      body,
      sentinel: reviewSummarySentinelForMode("review"),
      expiresAtTs: args.getTokenExpiresAtTs?.(),
      hintCommentId: args.summaryCommentIdHint,
    });
  } catch (error) {
    logWarn("review_stub_tick_failed", {
      owner: args.owner,
      repo: args.repo,
      pr: args.prNumber,
      workItemId: args.workItemId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
