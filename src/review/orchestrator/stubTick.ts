import { logWarn } from "../../evlog.ts";
import type { PrSurface } from "../../github/prSurface.ts";
import type { ReviewCancelAttribution, AnyReviewLens } from "../../settings/index.ts";
import {
  createReviewSummaryComment,
  type SummaryCommentCoordination,
} from "../publish/reviewSummaryComment.ts";
import type { ReviewHeadCiPort } from "../publish/reviewPublishSession.ts";
import { waitingCiSummary } from "../ci/ciFacts.ts";
import type { WorkSource } from "../reviewSchema.ts";
import {
  renderReviewCancelledNotice,
  renderReviewProgressComment,
  type SpecialistTickState,
} from "../run/progressComment.ts";
import { errorMessage } from "../../errors/errorMessage.ts";

type ProgressTickRevision = 1 | 2 | 3 | 4 | 5 | 6;
type SpecialistStatusTick = Extract<SpecialistTickState, { readonly kind: "specialists" }>;
type TerminalTick = Extract<SpecialistTickState, { readonly kind: "terminal" }>;

type TickCoordination = { readonly coordination: SummaryCommentCoordination };

function summaryWriter(
  args: TickCoordination & { readonly prSurface: PrSurface; readonly mode: AnyReviewLens },
) {
  return createReviewSummaryComment({
    prSurface: args.prSurface,
    reviewLens: args.mode,
    coordination: args.coordination,
  });
}

function tickWorkItemId(args: TickCoordination) {
  return args.coordination.workItemId;
}

type TickProgressCommentBase = TickCoordination & {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly mode: AnyReviewLens;
  readonly headSha: string;
  readonly source: WorkSource;
  readonly prSurface: PrSurface;
  readonly hintCommentId?: number | null;
  readonly headCi?: ReviewHeadCiPort;
};

export type TickProgressCommentArgs = TickProgressCommentBase &
  (
    | {
        readonly progressRevision: ProgressTickRevision;
        readonly tickState: SpecialistStatusTick;
      }
    | {
        readonly progressRevision: ProgressTickRevision | 7;
        readonly tickState: TerminalTick;
      }
  );

export type WriteCancelledProgressCommentArgs = TickCoordination & {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly mode: AnyReviewLens;
  readonly attribution: ReviewCancelAttribution;
  readonly prSurface: PrSurface;
  readonly hintCommentId?: number | null;
};

export async function tickProgressComment(args: TickProgressCommentArgs) {
  try {
    const rendered = (await args.headCi?.load(args.headSha)) ?? waitingCiSummary(0);
    const summary = summaryWriter(args);
    const write = {
      body: renderReviewProgressComment({
        mode: args.mode,
        headSha: args.headSha,
        source: args.source,
        ciSummary: rendered.summary,
        ciVersion: rendered.version,
        tickState: args.tickState,
        progressRevision: args.progressRevision,
        progressWorkItemId: tickWorkItemId(args),
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
    args.headCi?.requestProjection(args.headSha, rendered.version);
  } catch (error) {
    logWarn("review_progress_tick_failed", {
      mode: args.mode,
      owner: args.owner,
      repo: args.repo,
      pr: args.prNumber,
      progressRevision: args.progressRevision,
      message: errorMessage(error),
    });
  }
}

export async function writeCancelledProgressComment(args: WriteCancelledProgressCommentArgs) {
  try {
    await summaryWriter(args).conclude({
      body: renderReviewCancelledNotice({
        attribution: args.attribution,
        progressRevision: 7,
        progressWorkItemId: tickWorkItemId(args),
      }),
      hintCommentId: args.hintCommentId,
    });
  } catch (error) {
    logWarn("review_progress_cancel_notice_failed", {
      mode: args.mode,
      owner: args.owner,
      repo: args.repo,
      pr: args.prNumber,
      message: errorMessage(error),
    });
  }
}
