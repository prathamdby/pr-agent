import { DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE } from "../../settings/index.js";
import { MERGE_VERDICT_SAFE_TO_MERGE_PATTERNS } from "../../settings/index.js";
import type { ReviewPayload } from "../reviewSchema.js";
import { isInlineSeverity } from "../reviewSchema.js";
import { planInlinePlacements, type InlinePlacement } from "../placement/reviewDiffPlacement.js";
import type {
  CachedPrDiffIndex,
  CommentableRightLineRanges,
} from "../placement/reviewDiffIndex.js";

/** Overview/followUp leakage — reject before publish (repair loop), not substring scrub. */
const INTERNAL_FAILURE_PHRASING: RegExp[] = [
  /\bstructured publish\b.*\bfailed\b/is,
  /\b\d+\/\d+ attempt\(s\)\b/i,
  /\bcheck server logs\b/i,
  /\btooling budget\b.*\b(exhausted|exceeded)\b/i,
  /\bBEGIN_SHARED_METHODOLOGY\b/,
  /\bSingle-pass review contract\b/i,
];

function containsInternalFailurePhrasing(text: string): boolean {
  return INTERNAL_FAILURE_PHRASING.some((pattern) => pattern.test(text));
}

export type AnchorFailure = {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly index: number;
  readonly suggestedRanges?: CommentableRightLineRanges;
};

export type ReviewPayloadValidationResult =
  | { readonly ok: true; readonly placements: readonly InlinePlacement[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly anchorFailures: readonly AnchorFailure[];
    };

function formatRangePair([start, end]: [number, number]): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

function formatSuggestedRanges(ranges: CommentableRightLineRanges): string {
  const shown = ranges.slice(0, DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE);
  const suffix =
    ranges.length > DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE
      ? ` …${ranges.length - DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE} more ranges`
      : "";
  return `${shown.map(formatRangePair).join(", ")}${suffix}`;
}

function validatePlacementAnchor(
  placement: InlinePlacement,
  index: number,
  diffIndex: CachedPrDiffIndex | undefined,
  enforceInlineAnchorValidation: boolean,
): AnchorFailure | null {
  if (!enforceInlineAnchorValidation) return null;
  if (!isInlineSeverity(placement.finding.severity)) return null;
  if (placement.inlineLine != null) return null;
  if (!diffIndex) return null;
  const { finding } = placement;
  const entry = diffIndex.files.get(finding.file);
  if (!entry) {
    if (diffIndex.truncated) return null;
    if (diffIndex.listPullRequestFilesIngested && diffIndex.files.size === 0) return null;
    return {
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      index,
    };
  }
  if (entry.patchOmitted || entry.commentableRightLineRanges.length === 0) return null;
  return {
    file: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    index,
    suggestedRanges: entry.commentableRightLineRanges,
  };
}

function formatAnchorFailureRepairMessage(failures: readonly AnchorFailure[]): string {
  const lines = ["Inline anchor validation failed for the following findings:"];
  for (const failure of failures) {
    lines.push(
      `- findings[${failure.index}] ${failure.file}:${failure.startLine}-${failure.endLine} has no commentable anchor on the PR diff`,
    );
    if (failure.suggestedRanges && failure.suggestedRanges.length > 0) {
      lines.push(
        `  Commentable RIGHT-side lines for ${failure.file}: ${formatSuggestedRanges(
          failure.suggestedRanges,
        )}`,
      );
    }
  }
  lines.push("Fix all listed findings and call submitReview again with a complete ReviewPayload.");
  return lines.join("\n");
}

export function validateReviewPayload(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
  enforceInlineAnchorValidation?: boolean;
}): ReviewPayloadValidationResult {
  const overviewFields: Array<[string, string | null | undefined]> = [
    ["prCharacter", params.payload.prCharacter],
    ["securityConcerns", params.payload.securityConcerns],
    ["mergeVerdict.rationale", params.payload.mergeVerdict?.rationale],
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

  const enforceInlineAnchorValidation = params.enforceInlineAnchorValidation ?? true;
  const placements = planInlinePlacements(params.payload.findings, params.cachedDiffIndex);
  const anchorFailures: AnchorFailure[] = [];
  for (const [index, placement] of placements.entries()) {
    const anchorError = validatePlacementAnchor(
      placement,
      index,
      params.cachedDiffIndex,
      enforceInlineAnchorValidation,
    );
    if (anchorError) anchorFailures.push(anchorError);
  }

  if (anchorFailures.length > 0) {
    return {
      ok: false,
      message: formatAnchorFailureRepairMessage(anchorFailures),
      anchorFailures,
    };
  }

  const hasBlockingFindings = params.payload.findings.some(
    (f) => f.severity === "P0" || f.severity === "P1",
  );
  if (hasBlockingFindings && params.payload.mergeVerdict != null) {
    const verdict = params.payload.mergeVerdict;
    if (verdict.score > 3) {
      return {
        ok: false,
        message: "mergeVerdict.score must be <= 3 when P0/P1 findings are open on this pass",
        anchorFailures: [],
      };
    }
    if (MERGE_VERDICT_SAFE_TO_MERGE_PATTERNS.some((pattern) => pattern.test(verdict.rationale))) {
      return {
        ok: false,
        message:
          "mergeVerdict.rationale must not claim safe-to-merge while P0/P1 findings are open on this pass",
        anchorFailures: [],
      };
    }
  }

  return { ok: true, placements };
}
