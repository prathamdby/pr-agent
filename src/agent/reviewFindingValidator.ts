import { DEFAULT_MAX_REVIEW_FINDINGS } from "../settings/index.js";
import { containsBannedPublicOutput } from "./publicOutputSanitizer.js";
import type { ReviewFinding, ReviewPayload } from "./reviewSchema.js";
import { planInlinePlacements, type CachedPrDiffIndex, type InlinePlacement } from "./reviewLocationValidation.js";

function validateFindingPublicFields(finding: ReviewFinding, index: number): string | null {
  const fields: Array<[string, string | undefined]> = [
    ["title", finding.title],
    ["detail", finding.detail],
    ["fixPrompt", finding.fixPrompt],
  ];
  for (const [name, value] of fields) {
    if (value != null && containsBannedPublicOutput(value)) {
      return `findings[${index}].${name} contains banned public-output phrasing`;
    }
  }
  return null;
}

function validatePlacementAnchor(placement: InlinePlacement, index: number): string | null {
  if (!placement.inlinePosted) return null;
  if (placement.inlineLine != null) return null;
  const { finding } = placement;
  return `findings[${index}] has no commentable anchor on the PR diff for ${finding.file}:${finding.startLine}`;
}

export function validateReviewPayload(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
  maxInlineFindings?: number;
}): string | null {
  const overviewFields: Array<[string, string | null | undefined]> = [
    ["prCharacter", params.payload.prCharacter],
    ["securityConcerns", params.payload.securityConcerns],
  ];
  for (const [name, value] of overviewFields) {
    if (value != null && containsBannedPublicOutput(value)) {
      return `${name} contains banned public-output phrasing`;
    }
  }
  for (const [index, item] of params.payload.followUps.entries()) {
    if (containsBannedPublicOutput(item)) {
      return `followUps[${index}] contains banned public-output phrasing`;
    }
  }

  for (const [index, finding] of params.payload.findings.entries()) {
    const publicError = validateFindingPublicFields(finding, index);
    if (publicError) return publicError;
  }

  const placements = planInlinePlacements(
    params.payload.findings,
    params.maxInlineFindings ?? DEFAULT_MAX_REVIEW_FINDINGS,
    params.cachedDiffIndex,
  );
  for (const [index, placement] of placements.entries()) {
    const anchorError = validatePlacementAnchor(placement, index);
    if (anchorError) return anchorError;
  }

  return null;
}
