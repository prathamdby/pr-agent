import { buildReviewPathProfile, formatReviewPathProfileBlock } from "./reviewPathProfile.js";
import type { ReviewPreflightMetadata } from "./reviewPreflightFiles.js";
import { buildReviewSizeBudget, formatReviewSizeBudgetBlock } from "./reviewSizeBudget.js";
import {
  fetchPriorInlineReviewFeedback,
  formatPriorInlineFeedbackBlock,
} from "./reviewPriorFeedback.js";
import type { ReviewMode } from "./reviewSchema.js";

function buildTrustedReviewContextBlock(
  metadata: ReviewPreflightMetadata,
  extras?: { priorInlineFeedback?: string },
): string {
  const filenames = metadata.files.map((file) => file.filename);
  const pathProfile = buildReviewPathProfile(filenames);
  const sizeBudget = buildReviewSizeBudget({
    fileCount: metadata.fileCount,
    totalChanges: metadata.totalChanges,
    truncated: metadata.truncated,
  });

  const blocks = [
    formatReviewPathProfileBlock(pathProfile),
    "",
    formatReviewSizeBudgetBlock(sizeBudget),
  ];
  if (extras?.priorInlineFeedback) {
    blocks.push("", extras.priorInlineFeedback);
  }
  return blocks.join("\n");
}

export async function buildTrustedReviewContextForReview(params: {
  preflight: ReviewPreflightMetadata;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  reviewLens: ReviewMode;
  botUserId: number;
  onPriorFeedbackError?: (error: unknown) => void;
}): Promise<string> {
  let priorInlineFeedback: string | undefined;
  try {
    const threads = await fetchPriorInlineReviewFeedback(
      params.token,
      params.owner,
      params.repo,
      params.prNumber,
      params.reviewLens,
      params.botUserId,
    );
    priorInlineFeedback = formatPriorInlineFeedbackBlock(threads) || undefined;
  } catch (error) {
    params.onPriorFeedbackError?.(error);
  }

  return buildTrustedReviewContextBlock(params.preflight, {
    priorInlineFeedback,
  });
}
