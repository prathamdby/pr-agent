import {
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  type Config,
  type AnyReviewLens,
} from "../../settings/index.ts";
import {
  classifiedFailureLogFields,
  type ClassifiedFailure,
} from "../../errors/classifiedFailure.ts";
import { logWarn } from "../../evlog.ts";
import {
  createReviewSummaryComment,
  type SummaryCommentCoordination,
} from "../publish/reviewSummaryComment.ts";
import { renderReviewFailureNotice } from "./progressComment.ts";
import type { ReviewRunSetup } from "./reviewRunSetup.ts";
import { errorMessage } from "../../errors/errorMessage.ts";
import { renderFindingsSection, type FindingView } from "../findingIdentity/findingLifecycle.ts";

export async function publishReviewRunFailureNotice(params: {
  readonly cfg: Config;
  readonly setup: ReviewRunSetup;
  readonly summaryCoordination?: SummaryCommentCoordination;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly reviewMode: AnyReviewLens;
  readonly publishAttempts: number;
  readonly lastFailure?: ClassifiedFailure;
  readonly findingView: FindingView;
}) {
  logWarn("agent_publish_fallback", {
    mode: params.reviewMode,
    publishAttempts: params.publishAttempts,
    ...(params.lastFailure != null ? classifiedFailureLogFields(params.lastFailure) : {}),
  });
  const failureNotice = { mode: params.reviewMode, retryCommand: "/review" };
  const blankLine = "\n\n";
  const findingsBudget =
    REVIEW_SUMMARY_BODY_MAX_CHARS -
    renderReviewFailureNotice(failureNotice).length -
    blankLine.length;
  try {
    await createReviewSummaryComment({
      prSurface: params.setup.prSurface,
      reviewLens: params.reviewMode,
      coordination: params.summaryCoordination,
    }).conclude({
      body: renderReviewFailureNotice({
        ...failureNotice,
        findingsSection: renderFindingsSection(params.findingView, findingsBudget),
      }),
    });
  } catch (error) {
    logWarn("review_publish_fallback_comment_failed", {
      mode: params.reviewMode,
      owner: params.owner,
      repo: params.repo,
      pr: params.prNumber,
      message: errorMessage(error),
    });
  }
}
