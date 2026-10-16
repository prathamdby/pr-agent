import {
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  type Config,
  type AnyReviewLens,
} from "../../settings/index.js";
import {
  classifiedFailureLogFields,
  type ClassifiedFailure,
} from "../../errors/classifiedFailure.js";
import { logWarn } from "../../evlog.js";
import {
  createReviewSummaryComment,
  type SummaryCommentCoordination,
} from "../publish/reviewSummaryComment.js";
import { renderReviewFailureNotice } from "./progressComment.js";
import type { ReviewRunSetup } from "./reviewRunSetup.js";
import { errorMessage } from "../../errors/errorMessage.js";
import { renderFindingsSection, type FindingView } from "../findingIdentity/findingLifecycle.js";

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
}): Promise<void> {
  logWarn("agent_publish_fallback", {
    mode: params.reviewMode,
    publishAttempts: params.publishAttempts,
    ...(params.lastFailure != null ? classifiedFailureLogFields(params.lastFailure) : {}),
  });
  try {
    await createReviewSummaryComment({
      prSurface: params.setup.prSurface,
      reviewLens: params.reviewMode,
      coordination: params.summaryCoordination,
    }).conclude({ body: renderFailureNoticeWithFindings(params.reviewMode, params.findingView) });
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

export function renderFailureNoticeWithFindings(
  mode: AnyReviewLens,
  findingView: FindingView,
  reservedChars = 0,
): string {
  const notice = { mode, retryCommand: "/review" };
  const blankLine = "\n\n";
  const budget =
    REVIEW_SUMMARY_BODY_MAX_CHARS -
    renderReviewFailureNotice(notice).length -
    blankLine.length -
    reservedChars;
  return renderReviewFailureNotice({
    ...notice,
    findingsSection: renderFindingsSection(findingView, budget),
  });
}
