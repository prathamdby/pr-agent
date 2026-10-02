import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { enqueueCiProjectionIfDue, loadRenderableHeadCi } from "../../agentWork/ciProjection.js";
import { logWarn } from "../../evlog.js";
import type { PrSurface } from "../../github/prSurface.js";
import type { ReviewCancelAttribution } from "../../settings/reviewConstants.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { createReviewSummaryComment } from "../publish/reviewSummaryComment.js";
import type { WorkSource } from "../reviewSchema.js";
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
  readonly prSurface: PrSurface;
  readonly hintCommentId?: number | null;
  readonly installationId?: number;
  readonly boss?: PgBoss;
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
  readonly prSurface: PrSurface;
  readonly hintCommentId?: number | null;
};

export async function tickProgressComment(args: TickProgressCommentArgs): Promise<void> {
  try {
    const rendered = await loadRenderableHeadCi(args.pool, args.owner, args.repo, args.headSha);
    const summary = createReviewSummaryComment({
      prSurface: args.prSurface,
      reviewLens: args.mode,
      coordination: {
        pool: args.pool,
        resourceKey: args.resourceKey,
        workItemId: args.workItemId,
      },
    });
    const write = {
      body: renderReviewProgressComment({
        mode: args.mode,
        headSha: args.headSha,
        source: args.source,
        ciSummary: rendered.summary,
        ciVersion: rendered.version,
        tickState: args.tickState,
        progressRevision: args.progressRevision,
        progressWorkItemId: args.workItemId,
      }),
      hintCommentId: args.hintCommentId,
      ciHeadSha: args.headSha,
      ciVersion: rendered.version,
    };
    if (args.progressRevision === 7) {
      await summary.conclude(write);
    } else {
      await summary.tick({ ...write, progressRevision: args.progressRevision });
    }
    await enqueueCiProjectionIfDue({
      boss: args.boss,
      pool: args.pool,
      installationId: args.installationId ?? 0,
      owner: args.owner,
      repo: args.repo,
      headSha: args.headSha,
      renderedVersion: rendered.version,
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
    await createReviewSummaryComment({
      prSurface: args.prSurface,
      reviewLens: args.mode,
      coordination: {
        pool: args.pool,
        resourceKey: args.resourceKey,
        workItemId: args.workItemId,
      },
    }).conclude({
      body: renderReviewCancelledNotice({
        attribution: args.attribution,
        progressRevision: 7,
        progressWorkItemId: args.workItemId,
      }),
      hintCommentId: args.hintCommentId,
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
