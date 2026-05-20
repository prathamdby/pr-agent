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
    `_PR Agent ${params.mode === "review-security" ? "security review" : "review"} failed after retries._`,
    "",
    `Please retry with \`${params.retryCommand}\`.`,
  ].join("\n");
}

export function renderStructuredPublishFallback(params: {
  mode: ReviewMode;
  summary: string;
  attempts: number;
  maxAttempts: number;
}): string {
  const retryCommand = params.mode === "review-security" ? "/review-security" : "/review";
  return [
    reviewSummarySentinelForMode(params.mode),
    "",
    `_Structured publish failed after ${params.attempts}/${params.maxAttempts} attempt(s)._`,
    "",
    `Re-run \`${retryCommand}\` or check server logs.`,
    "",
    params.summary,
  ].join("\n");
}
