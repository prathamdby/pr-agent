import type { PrSurface } from "../../github/prSurface.js";
import type { InlinePlacement } from "./reviewDiffPlacement.js";
import {
  isLineResolutionPublishError,
  lineResolutionPublishErrorHint,
  type LineResolutionPublishErrorHint,
} from "../../github/reviewErrors.js";
import { compareReviewFindingsBySeverityFileLine } from "../findings/reviewFindingSort.js";
import type { ReviewFinding } from "../reviewSchema.js";
import type { InlineReviewComment } from "../../github/reviewPublish.js";

type InlinePublishParams<TPlacement extends InlinePlacement> = {
  prSurface: PrSurface;
  renderReviewBody: (anchorDroppedPlacements: readonly InlinePlacement[]) => string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  commitId?: string;
  inlinePlacements: readonly TPlacement[];
  renderCommentBody: (finding: ReviewFinding) => string;
};

export type InlinePublishResult<TPlacement extends InlinePlacement = InlinePlacement> = {
  review?: { id: number; url: string };
  postedPlacements: TPlacement[];
  anchorDroppedPlacements: TPlacement[];
  lineResolutionFallback: boolean;
};

function inlineCommentsFromPlacements(
  placements: readonly InlinePlacement[],
  renderCommentBody: (finding: ReviewFinding) => string,
  commentByPlacement: Map<InlinePlacement, InlineReviewComment>,
): InlineReviewComment[] {
  return placements.flatMap((placement) => {
    if (!placement.inlinePosted || placement.inlineLine == null) return [];
    const cached = commentByPlacement.get(placement);
    if (cached) return [cached];
    const comment = {
      path: placement.finding.file,
      line: placement.inlineLine,
      side: "RIGHT" as const,
      body: renderCommentBody(placement.finding),
    };
    commentByPlacement.set(placement, comment);
    return [comment];
  });
}

function matchesLineResolutionHint(
  placement: InlinePlacement,
  hint: LineResolutionPublishErrorHint,
): boolean {
  if (hint.path != null && placement.finding.file !== hint.path) return false;
  if (hint.line != null && placement.inlineLine !== hint.line) return false;
  return hint.path != null || hint.line != null;
}

function hintedLineResolutionDrop<TPlacement extends InlinePlacement>(
  placements: readonly TPlacement[],
  error: Error,
): TPlacement[] | undefined {
  const hint = lineResolutionPublishErrorHint(error);
  if (hint != null) {
    const matches = placements.filter((placement) => matchesLineResolutionHint(placement, hint));
    if (matches.length === 1) return matches;
  }
  return undefined;
}

function fallbackLineResolutionDrop<TPlacement extends InlinePlacement>(
  placements: readonly TPlacement[],
  dropOrder: readonly TPlacement[],
): TPlacement[] {
  const active = new Set(placements);
  for (const placement of dropOrder) {
    if (!active.has(placement)) continue;
    return [placement];
  }
  return [];
}

export async function publishInlineReviewComments<TPlacement extends InlinePlacement>(
  params: InlinePublishParams<TPlacement>,
): Promise<InlinePublishResult<TPlacement>> {
  let attemptPlacements = params.inlinePlacements.filter(
    (placement) => placement.inlinePosted && placement.inlineLine != null,
  );
  const anchorDroppedPlacements: TPlacement[] = [];
  const commentByPlacement = new Map<InlinePlacement, InlineReviewComment>();
  const dropOrder = [...attemptPlacements].toSorted((a, b) =>
    compareReviewFindingsBySeverityFileLine(b.finding, a.finding),
  );

  while (attemptPlacements.length > 0) {
    const comments = inlineCommentsFromPlacements(
      attemptPlacements,
      params.renderCommentBody,
      commentByPlacement,
    );
    try {
      const review = await params.prSurface.publishThreadBatch({
        body: params.renderReviewBody(anchorDroppedPlacements),
        event: params.event,
        comments,
        commitId: params.commitId,
      });
      return {
        review: { id: review.reviewId, url: review.reviewUrl },
        postedPlacements: attemptPlacements,
        anchorDroppedPlacements,
        lineResolutionFallback: anchorDroppedPlacements.length > 0,
      };
    } catch (error) {
      if (!(error instanceof Error) || !isLineResolutionPublishError(error)) {
        throw error;
      }
      const hintedDrop = hintedLineResolutionDrop(attemptPlacements, error);
      const dropped = hintedDrop ?? fallbackLineResolutionDrop(attemptPlacements, dropOrder);
      if (dropped.length === 0) {
        break;
      }
      const droppedSet = new Set(dropped);
      for (const placement of dropped) {
        anchorDroppedPlacements.push({
          ...placement,
          inlinePosted: false,
          inlineLine: placement.inlineLine,
        });
      }
      attemptPlacements = attemptPlacements.filter((placement) => !droppedSet.has(placement));
    }
  }

  return {
    postedPlacements: [],
    anchorDroppedPlacements,
    lineResolutionFallback: anchorDroppedPlacements.length > 0,
  };
}
