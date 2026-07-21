import {
  buildReviewPathProfile,
  formatReviewPathProfileBlock,
} from "../placement/reviewPathProfile.js";
import type { ReviewPreflightMetadata } from "../placement/reviewPreflightFiles.js";
import { buildReviewSizeBudget, formatReviewSizeBudgetBlock } from "../run/reviewSizeBudget.js";
import {
  fetchPriorInlineReviewFeedback,
  formatPriorInlineFeedbackBlock,
} from "../run/reviewPriorFeedback.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";

function buildTrustedReviewContextBlock(
  metadata: ReviewPreflightMetadata,
  extras?: {
    priorInlineFeedback?: string;
    repoPolicyBlock?: string;
    agentInstructionFilesBlock?: string;
  },
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
  if (extras?.repoPolicyBlock) {
    blocks.push("", extras.repoPolicyBlock);
  }
  if (extras?.agentInstructionFilesBlock) {
    blocks.push("", extras.agentInstructionFilesBlock);
  }
  return blocks.join("\n");
}

export function buildTrustedReviewContextForReview(params: {
  preflight: ReviewPreflightMetadata;
  priorInlineFeedback?: string;
  repoPolicyBlock?: string;
  agentInstructionFilesBlock?: string;
}): string {
  return buildTrustedReviewContextBlock(params.preflight, {
    priorInlineFeedback: params.priorInlineFeedback,
    repoPolicyBlock: params.repoPolicyBlock,
    agentInstructionFilesBlock: params.agentInstructionFilesBlock,
  });
}

export async function fetchPriorInlineFeedbackBlockForReview(params: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  reviewLens: AnyReviewLens;
  botUserId: number;
  onPriorFeedbackError?: (error: unknown) => void;
}): Promise<string | undefined> {
  try {
    const threads = await fetchPriorInlineReviewFeedback(
      params.token,
      params.owner,
      params.repo,
      params.prNumber,
      params.reviewLens,
      params.botUserId,
    );
    return formatPriorInlineFeedbackBlock(threads) || undefined;
  } catch (error) {
    params.onPriorFeedbackError?.(error);
    return undefined;
  }
}
