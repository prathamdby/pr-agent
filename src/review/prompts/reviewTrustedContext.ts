import {
  buildReviewPathProfile,
  formatReviewPathProfileBlock,
} from "../placement/reviewPathProfile.js";
import type { ReviewPreflightMetadata } from "../placement/reviewPreflightFiles.js";
import {
  buildReviewSizeBudget,
  formatCheckoutCoverageBlock,
  formatReviewSizeBudgetBlock,
} from "../run/reviewSizeBudget.js";
import type { CheckoutCoverage } from "../../prWorkspace/localPrWorkspace.js";
import type { SymbolIndexStatus } from "../../prWorkspace/symbolIndex.js";
import { formatSymbolIndexStatusLine } from "../../prWorkspace/symbolIndex.js";
import type { CodeIndexPrepareResult } from "../../codeIndex/buildJob.js";
import { formatCodeIndexStatusLine } from "../../codeIndex/buildJob.js";
import type { PrSurface } from "../../github/prSurface.js";
import { formatPriorInlineFeedbackBlock } from "../run/reviewPriorFeedback.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";

export function buildTrustedReviewContextForReview(params: {
  preflight: ReviewPreflightMetadata;
  priorInlineFeedback?: string;
  findingHistoryTrustedBlock?: string;
  repoPolicyBlock?: string;
  agentInstructionFilesBlock?: string;
  checkoutCoverage?: CheckoutCoverage;
  symbolIndexStatus?: SymbolIndexStatus;
  codeIndexStatus?: CodeIndexPrepareResult;
}): string {
  const filenames = params.preflight.files.map((file) => file.filename);
  const pathProfile = buildReviewPathProfile(filenames);
  const sizeBudget = buildReviewSizeBudget({
    fileCount: params.preflight.fileCount,
    totalChanges: params.preflight.totalChanges,
    truncated: params.preflight.truncated,
  });

  const blocks = [
    formatReviewPathProfileBlock(pathProfile),
    "",
    formatReviewSizeBudgetBlock(sizeBudget),
  ];
  if (params.checkoutCoverage) {
    blocks.push("", formatCheckoutCoverageBlock(params.checkoutCoverage));
  }
  if (params.symbolIndexStatus) {
    blocks.push("", formatSymbolIndexStatusLine(params.symbolIndexStatus));
  }
  if (params.codeIndexStatus) {
    blocks.push("", formatCodeIndexStatusLine(params.codeIndexStatus));
  }
  if (params.priorInlineFeedback) {
    blocks.push("", params.priorInlineFeedback);
  }
  if (params.findingHistoryTrustedBlock) {
    blocks.push("", params.findingHistoryTrustedBlock);
  }
  if (params.repoPolicyBlock) {
    blocks.push("", params.repoPolicyBlock);
  }
  if (params.agentInstructionFilesBlock) {
    blocks.push("", params.agentInstructionFilesBlock);
  }
  return blocks.join("\n");
}

export async function fetchPriorInlineFeedbackBlockForReview(params: {
  prSurface: PrSurface;
  botUserId: number;
  reviewLens: AnyReviewLens;
  maintainerDecisionAssociations?: ReadonlySet<string>;
  onPriorFeedbackError?: (error: unknown) => void;
}): Promise<string | undefined> {
  try {
    const threads = await params.prSurface.fetchPriorInlineFeedback(
      params.botUserId,
      params.reviewLens,
      params.maintainerDecisionAssociations,
    );
    return (
      formatPriorInlineFeedbackBlock(
        threads.map((thread) => ({
          ...thread,
          humanReplies: [...thread.humanReplies],
          ...(thread.authorizedReplies != null
            ? { authorizedReplies: [...thread.authorizedReplies] }
            : {}),
          ...(thread.untrustedReplies != null
            ? { untrustedReplies: [...thread.untrustedReplies] }
            : {}),
          ...(thread.replies != null ? { replies: [...thread.replies] } : {}),
        })),
      ) || undefined
    );
  } catch (error) {
    params.onPriorFeedbackError?.(error);
    return undefined;
  }
}
