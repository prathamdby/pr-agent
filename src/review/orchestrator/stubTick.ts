import type { Pool } from "pg";
import { logWarn } from "../../evlog.js";
import type { ReviewCancelAttribution } from "../../settings/reviewConstants.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { upsertSummaryCommentWithCreationClaim } from "../publish/publishReview.js";
import { REVIEW_SUMMARY_SENTINEL, type WorkSource } from "../reviewSchema.js";
import {
  renderReviewCancelledNotice,
  renderReviewProgressComment,
  type SpecialistTickState,
} from "../run/progressComment.js";

type ProgressTickRevision = 1 | 2 | 3 | 4 | 5 | 6;
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
  readonly refreshLiveAuth?: () => Promise<void>;
  readonly hintCommentId?: number | null;
};

export type TickProgressCommentArgs = TickProgressCommentBase &
  (
    | {
        readonly progressRevision: ProgressTickRevision;
        readonly tickState: SpecialistStatusTick;
      }
    | {
        readonly progressRevision: 7;
        readonly tickState: TerminalTick;
      }
  );

export type WriteCancelledProgressCommentArgs = {
  readonly pool: Pool;
  readonly workItemId: string;
  readonly resourceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly mode: AnyReviewLens;
  readonly attribution: ReviewCancelAttribution;
  readonly getToken: () => string;
  readonly getTokenExpiresAtTs: () => number | undefined;
  readonly refreshLiveAuth?: () => Promise<void>;
  readonly hintCommentId?: number | null;
};

export async function tickProgressComment(args: TickProgressCommentArgs): Promise<void> {
  try {
    await args.refreshLiveAuth?.();
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
      sentinel: REVIEW_SUMMARY_SENTINEL,
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

/** Replace the progress comment with the failure-style cancelled notice (no roster table). */
export async function writeCancelledProgressComment(
  args: WriteCancelledProgressCommentArgs,
): Promise<void> {
  try {
    await args.refreshLiveAuth?.();
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
      body: renderReviewCancelledNotice({
        attribution: args.attribution,
        progressRevision: 7,
        progressWorkItemId: args.workItemId,
      }),
      sentinel: REVIEW_SUMMARY_SENTINEL,
      expiresAtTs,
      hintCommentId: args.hintCommentId,
      progressRevision: 7,
    });
  } catch (error) {
    logWarn("review_progress_cancel_notice_failed", {
      mode: args.mode,
      owner: args.owner,
      repo: args.repo,
      pr: args.prNumber,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
