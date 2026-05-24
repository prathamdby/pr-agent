import { DEFAULT_MAX_REVIEW_FINDINGS } from "../settings/index.js";
import { containsInternalFailurePhrasing } from "./publicOutputSanitizer.js";
import type { ReviewPayload } from "./reviewSchema.js";
import {
  planInlinePlacements,
  type CachedPrDiffIndex,
  type InlinePlacement,
} from "./reviewLocationValidation.js";
import type { CommentableRightLineRanges } from "./reviewDiffIndex.js";

export type AnchorFailure = {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly index: number;
  readonly suggestedRanges?: CommentableRightLineRanges;
};

export type ReviewPayloadValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      readonly anchorFailures: readonly AnchorFailure[];
    };

function validatePlacementAnchor(
  placement: InlinePlacement,
  index: number,
  diffIndex: CachedPrDiffIndex | undefined,
): AnchorFailure | null {
  if (!placement.inlineCapEligible) return null;
  if (placement.inlineLine != null) return null;
  if (!diffIndex) return null;
  const { finding } = placement;
  const entry = diffIndex.files.get(finding.file);
  if (entry?.patchOmitted) return null;
  return {
    file: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    index,
    suggestedRanges: entry?.commentableRightLineRanges,
  };
}

export function formatAnchorFailureRepairMessage(failures: readonly AnchorFailure[]): string {
  const lines = ["Inline anchor validation failed for the following findings:"];
  for (const failure of failures) {
    lines.push(
      `- findings[${failure.index}] ${failure.file}:${failure.startLine}-${failure.endLine} has no commentable anchor on the PR diff`,
    );
    if (failure.suggestedRanges && failure.suggestedRanges.length > 0) {
      const ranges = failure.suggestedRanges.map(([s, e]: [number, number]) =>
        s === e ? `${s}` : `${s}-${e}`,
      );
      lines.push(`  Commentable RIGHT-side lines for ${failure.file}: ${ranges.join(", ")}`);
    }
  }
  lines.push("Fix all listed findings and call submitReview again with a complete ReviewPayload.");
  return lines.join("\n");
}

export function validateReviewPayload(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
  maxInlineFindings?: number;
}): ReviewPayloadValidationResult {
  const overviewFields: Array<[string, string | null | undefined]> = [
    ["prCharacter", params.payload.prCharacter],
    ["securityConcerns", params.payload.securityConcerns],
  ];
  for (const [name, value] of overviewFields) {
    if (value != null && containsInternalFailurePhrasing(value)) {
      return {
        ok: false,
        message: `${name} contains banned public-output phrasing`,
        anchorFailures: [],
      };
    }
  }
  for (const [index, item] of params.payload.followUps.entries()) {
    if (containsInternalFailurePhrasing(item)) {
      return {
        ok: false,
        message: `followUps[${index}] contains banned public-output phrasing`,
        anchorFailures: [],
      };
    }
  }

  const placements = planInlinePlacements(
    params.payload.findings,
    params.maxInlineFindings ?? DEFAULT_MAX_REVIEW_FINDINGS,
    params.cachedDiffIndex,
  );
  const anchorFailures: AnchorFailure[] = [];
  for (const [index, placement] of placements.entries()) {
    const anchorError = validatePlacementAnchor(placement, index, params.cachedDiffIndex);
    if (anchorError) anchorFailures.push(anchorError);
  }

  if (anchorFailures.length > 0) {
    return {
      ok: false,
      message: formatAnchorFailureRepairMessage(anchorFailures),
      anchorFailures,
    };
  }

  return { ok: true };
}
