import { containsBannedPublicOutput } from "./publicOutputSanitizer.js";
import type { ReviewFinding, ReviewPayload } from "./reviewSchema.js";
import type { CachedPrDiffIndex } from "./reviewLocationValidation.js";
import { resolveInlineAnchorLine } from "./reviewDiffIndex.js";

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

function validateFindingAnchor(
  finding: ReviewFinding,
  index: number,
  cachedDiffIndex?: CachedPrDiffIndex,
): string | null {
  if (finding.severity === "P3") return null;
  if (cachedDiffIndex == null || cachedDiffIndex.files.size === 0) return null;
  const anchor = resolveInlineAnchorLine(
    cachedDiffIndex,
    finding.file,
    finding.startLine,
    finding.endLine,
  );
  if (anchor == null) {
    return `findings[${index}] has no commentable anchor on the PR diff for ${finding.file}:${finding.startLine}`;
  }
  return null;
}

export function validateReviewPayload(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
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
    const anchorError = validateFindingAnchor(finding, index, params.cachedDiffIndex);
    if (anchorError) return anchorError;
  }

  return null;
}
