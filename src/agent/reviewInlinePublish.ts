import {
  createPullRequestReviewWithComments,
  type InlineReviewComment,
} from "../github/reviewPublish.js";
import { withTransientReviewRetry } from "../github/reviewPublishRetry.js";
import type { InlinePlacement } from "./reviewDiffPlacement.js";
import { isLineResolutionPublishError } from "./reviewDiffPlacement.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import type { ReviewFinding } from "./reviewSchema.js";

export type InlinePublishResult = {
  review?: { id: number; url: string };
  postedPlacements: InlinePlacement[];
  anchorDroppedPlacements: InlinePlacement[];
  lineResolutionFallback: boolean;
};

function inlineCommentsFromPlacements(
  placements: readonly InlinePlacement[],
  renderCommentBody: (finding: ReviewFinding) => string,
): InlineReviewComment[] {
  return placements.flatMap((placement) => {
    if (!placement.inlinePosted || placement.inlineLine == null) return [];
    return [
      {
        path: placement.finding.file,
        line: placement.inlineLine,
        side: "RIGHT" as const,
        body: renderCommentBody(placement.finding),
      },
    ];
  });
}

/** Drop lowest-severity inline placement first when GitHub rejects line anchors. */
function dropLowestPriorityInlinePlacement(placements: InlinePlacement[]): {
  remaining: InlinePlacement[];
  dropped: InlinePlacement | null;
} {
  if (placements.length === 0) {
    return { remaining: placements, dropped: null };
  }
  const ordered = [...placements].toSorted((a, b) =>
    compareReviewFindingsBySeverityFileLine(a.finding, b.finding),
  );
  const dropped = ordered[ordered.length - 1]!;
  return {
    remaining: placements.filter((placement) => placement !== dropped),
    dropped,
  };
}

export async function publishInlineReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  params: {
    renderReviewBody: (anchorDroppedPlacements: readonly InlinePlacement[]) => string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    commitId?: string;
    inlinePlacements: readonly InlinePlacement[];
    renderCommentBody: (finding: ReviewFinding) => string;
  },
): Promise<InlinePublishResult> {
  let attemptPlacements = params.inlinePlacements.filter(
    (placement) => placement.inlinePosted && placement.inlineLine != null,
  );
  const anchorDroppedPlacements: InlinePlacement[] = [];
  const initialCount = attemptPlacements.length;

  for (let attempt = 0; attempt < initialCount && attemptPlacements.length > 0; attempt++) {
    const prevCount = attemptPlacements.length;
    const comments = inlineCommentsFromPlacements(attemptPlacements, params.renderCommentBody);
    try {
      const review = await withTransientReviewRetry(() =>
        createPullRequestReviewWithComments(token, owner, repo, pullNumber, {
          body: params.renderReviewBody(anchorDroppedPlacements),
          event: params.event,
          comments,
          commitId: params.commitId,
        }),
      );
      return {
        review,
        postedPlacements: attemptPlacements.map((placement) => ({
          ...placement,
          inlinePosted: true,
        })),
        anchorDroppedPlacements,
        lineResolutionFallback: anchorDroppedPlacements.length > 0,
      };
    } catch (error) {
      if (!isLineResolutionPublishError(error)) {
        throw error;
      }
      const { remaining, dropped } = dropLowestPriorityInlinePlacement(attemptPlacements);
      if (!dropped) {
        break;
      }
      anchorDroppedPlacements.push({
        ...dropped,
        inlinePosted: false,
        inlineLine: dropped.inlineLine,
      });
      if (remaining.length >= prevCount) {
        break;
      }
      attemptPlacements = remaining;
    }
  }

  const allAnchorDroppedPlacements = [
    ...anchorDroppedPlacements,
    ...attemptPlacements.map((placement) => ({
      ...placement,
      inlinePosted: false,
    })),
  ];

  return {
    postedPlacements: [],
    anchorDroppedPlacements: allAnchorDroppedPlacements,
    lineResolutionFallback: anchorDroppedPlacements.length > 0,
  };
}
