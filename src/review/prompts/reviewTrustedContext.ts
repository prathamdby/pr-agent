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

function buildTrustedReviewContextBlock(
  metadata: ReviewPreflightMetadata,
  extras?: {
    priorInlineFeedback?: string;
    findingHistoryTrustedBlock?: string;
    repoPolicyBlock?: string;
    agentInstructionFilesBlock?: string;
    checkoutCoverage?: CheckoutCoverage;
    symbolIndexStatus?: SymbolIndexStatus;
    codeIndexStatus?: CodeIndexPrepareResult;
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
  if (extras?.checkoutCoverage) {
    blocks.push("", formatCheckoutCoverageBlock(extras.checkoutCoverage));
  }
  if (extras?.symbolIndexStatus) {
    blocks.push("", formatSymbolIndexStatusLine(extras.symbolIndexStatus));
  }
  if (extras?.codeIndexStatus) {
    blocks.push("", formatCodeIndexStatusLine(extras.codeIndexStatus));
  }
  if (extras?.priorInlineFeedback) {
    blocks.push("", extras.priorInlineFeedback);
  }
  if (extras?.findingHistoryTrustedBlock) {
    blocks.push("", extras.findingHistoryTrustedBlock);
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
  findingHistoryTrustedBlock?: string;
  repoPolicyBlock?: string;
  agentInstructionFilesBlock?: string;
  checkoutCoverage?: CheckoutCoverage;
  symbolIndexStatus?: SymbolIndexStatus;
  codeIndexStatus?: CodeIndexPrepareResult;
}): string {
  return buildTrustedReviewContextBlock(params.preflight, {
    priorInlineFeedback: params.priorInlineFeedback,
    findingHistoryTrustedBlock: params.findingHistoryTrustedBlock,
    repoPolicyBlock: params.repoPolicyBlock,
    agentInstructionFilesBlock: params.agentInstructionFilesBlock,
    checkoutCoverage: params.checkoutCoverage,
    symbolIndexStatus: params.symbolIndexStatus,
    codeIndexStatus: params.codeIndexStatus,
  });
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
