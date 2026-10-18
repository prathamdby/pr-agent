import type { PrSurface } from "../../github/prSurface.ts";
import type { AnyReviewLens } from "../../settings/index.ts";
import { fetchPriorInlineFeedback } from "./reviewPriorFeedback.ts";
import { formatPriorInlineFeedbackBlock } from "../../prompts/orchestrator/prompt.ts";

export async function fetchPriorInlineFeedbackBlockForReview(params: {
  prSurface: PrSurface;
  botUserId: number;
  reviewLens: AnyReviewLens;
  maintainerDecisionAssociations?: ReadonlySet<string>;
  onPriorFeedbackError?: (error: unknown) => void;
}): Promise<string | undefined> {
  try {
    const threads = await fetchPriorInlineFeedback(params.prSurface, {
      botUserId: params.botUserId,
      currentLens: params.reviewLens,
      maintainerDecisionAssociations: params.maintainerDecisionAssociations,
    });
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
