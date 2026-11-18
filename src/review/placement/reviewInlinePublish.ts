import type { PrSurface } from "../../github/prSurface.ts";
import type { InlinePlacement } from "./reviewDiffPlacement.ts";
import {
  isInlineAnchorPublishError,
  lineResolutionPublishErrorHint,
  type LineResolutionPublishErrorHint,
} from "../../github/reviewErrors.ts";
import { compareReviewFindingsBySeverityFileLine } from "../findings/reviewFindingSort.ts";
import type { InlineReviewComment } from "../../github/reviewPublish.ts";

type InlinePublishParams<TPlacement extends InlinePlacement> = {
  prSurface: PrSurface;
  renderReviewBody: (anchorDroppedPlacements: readonly InlinePlacement[]) => string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  commitId?: string;
  inlinePlacements: readonly TPlacement[];
  renderCommentBody: (placement: TPlacement) => string;
};

export type InlinePublishResult<TPlacement extends InlinePlacement = InlinePlacement> = {
  review?: { id: number; url: string };
  postedPlacements: TPlacement[];
  anchorDroppedPlacements: TPlacement[];
  lineResolutionFallback: boolean;
};

function inlineCommentsFromPlacements<TPlacement extends InlinePlacement>(
  placements: readonly TPlacement[],
  renderCommentBody: (placement: TPlacement) => string,
  commentByPlacement: Map<InlinePlacement, InlineReviewComment>,
) {
  return ((pinnedReturn: InlineReviewComment[]) => pinnedReturn)(
    placements.flatMap((placement) => {
      if (!placement.inlinePosted || placement.inlineLine == null) return [];
      const cached = commentByPlacement.get(placement);
      if (cached) return [cached];
      const comment = {
        path: placement.finding.file,
        line: placement.inlineLine,
        side: "RIGHT" as const,
        body: renderCommentBody(placement),
      };
      commentByPlacement.set(placement, comment);
      return [comment];
    }),
  );
}

function matchesLineResolutionHint(
  placement: InlinePlacement,
  hint: LineResolutionPublishErrorHint,
) {
  if (hint.path != null && placement.finding.file !== hint.path)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (hint.line != null && placement.inlineLine !== hint.line)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(hint.path != null || hint.line != null);
}

function hintedLineResolutionDrop<TPlacement extends InlinePlacement>(
  placements: readonly TPlacement[],
  error: unknown,
) {
  const hint = lineResolutionPublishErrorHint(error);
  if (hint != null) {
    const matches = placements.filter((placement) => matchesLineResolutionHint(placement, hint));
    if (matches.length === 1)
      return ((pinnedReturn: TPlacement[] | undefined) => pinnedReturn)(matches);
  }
  return ((pinnedReturn: TPlacement[] | undefined) => pinnedReturn)(undefined);
}

function fallbackLineResolutionDrop<TPlacement extends InlinePlacement>(
  placements: readonly TPlacement[],
  dropOrder: readonly TPlacement[],
) {
  const active = new Set(placements);
  for (const placement of dropOrder) {
    if (!active.has(placement)) continue;
    return ((pinnedReturn: TPlacement[]) => pinnedReturn)([placement]);
  }
  return ((pinnedReturn: TPlacement[]) => pinnedReturn)([]);
}

export async function publishInlineReviewComments<TPlacement extends InlinePlacement>(
  params: InlinePublishParams<TPlacement>,
) {
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
      return ((
        pinnedReturn: InlinePublishResult<TPlacement> | Promise<InlinePublishResult<TPlacement>>,
      ) => pinnedReturn)({
        review: { id: review.reviewId, url: review.reviewUrl },
        postedPlacements: attemptPlacements,
        anchorDroppedPlacements,
        lineResolutionFallback: anchorDroppedPlacements.length > 0,
      });
    } catch (error) {
      if (!isInlineAnchorPublishError(error)) {
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

  return ((
    pinnedReturn: InlinePublishResult<TPlacement> | Promise<InlinePublishResult<TPlacement>>,
  ) => pinnedReturn)({
    postedPlacements: [],
    anchorDroppedPlacements,
    lineResolutionFallback: anchorDroppedPlacements.length > 0,
  });
}
