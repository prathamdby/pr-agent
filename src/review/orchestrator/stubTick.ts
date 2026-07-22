import type { Pool } from "pg";
import { logWarn } from "../../evlog.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { upsertSummaryCommentWithCreationClaim } from "../publish/publishReview.js";
import { reviewSummarySentinelForMode, type WorkSource } from "../reviewSchema.js";
import { renderReviewProgressComment, type SpecialistTickState } from "../run/progressComment.js";

type SpecialistProgressRevision = 1 | 2 | 3 | 4;
type SpecialistStatusTick = Extract<SpecialistTickState, { readonly kind: "specialists" }>;
type TerminalTick = Extract<SpecialistTickState, { readonly kind: "terminal" }>;

type TickProgressCommentBase = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly mode: AnyReviewLens;
  readonly headSha: string;
  readonly source: WorkSource;
  readonly ciSummary?: CiSummary | null;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs: () => number | undefined;
  readonly hintCommentId?: number | null;
};

export type TickProgressCommentArgs = TickProgressCommentBase &
  (
    | {
        readonly progressRevision: SpecialistProgressRevision;
        readonly tickState: SpecialistStatusTick;
      }
    | {
        readonly progressRevision: 5;
        readonly tickState: TerminalTick;
      }
  );

export async function tickProgressComment(args: TickProgressCommentArgs): Promise<void> {
  try {
    const token = args.getToken();
    const expiresAtTs = args.getTokenExpiresAtTs();
    await upsertSummaryCommentWithCreationClaim({
      pool: args.pool,
      workItemId: args.workItemId,
      resourceKey: args.resourceKey,
      reviewLens: args.mode,
      token,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      body: renderReviewProgressComment({
        mode: args.mode,
        headSha: args.headSha,
        source: args.source,
        ciSummary: args.ciSummary,
        tickState: args.tickState,
        progressRevision: args.progressRevision,
        progressWorkItemId: args.workItemId,
      }),
      sentinel: reviewSummarySentinelForMode(args.mode),
      expiresAtTs,
      hintCommentId: args.hintCommentId,
      progressRevision: args.progressRevision,
    });
  } catch (error) {
    logWarn("review_progress_tick_failed", {
      mode: args.mode,
      owner: args.owner,
      repo: args.repo,
      pr: args.prNumber,
      progressRevision: args.progressRevision,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
