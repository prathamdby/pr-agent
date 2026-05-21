import { reviewSummarySentinelForMode, type ReviewMode } from "../agent/reviewSchema.js";

export function renderReviewProgressComment(params: {
  mode: ReviewMode;
  headSha: string;
  source: "auto" | "slash";
}): string {
  const lens = params.mode === "review-security" ? "security review" : "review";
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    `_PR Agent ${lens} in progress._`,
    "",
    `Head SHA: \`${params.headSha}\``,
    `Source: ${params.source === "auto" ? "automated pull request event" : "slash command"}`,
  ].join("\n");
}

export function renderReviewFailureNotice(params: {
  mode: ReviewMode;
  retryCommand: string;
}): string {
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    `_PR Agent could not complete this ${params.mode === "review-security" ? "security review" : "review"}._`,
    "",
    `Please retry with \`${params.retryCommand}\`.`,
  ].join("\n");
}

/** @deprecated Use renderReviewFailureNotice — kept for callers migrating off structured publish wording. */
export function renderStructuredPublishFallback(params: { mode: ReviewMode }): string {
  const retryCommand = params.mode === "review-security" ? "/review-security" : "/review";
  return renderReviewFailureNotice({ mode: params.mode, retryCommand });
}
