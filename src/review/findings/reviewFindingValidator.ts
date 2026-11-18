import { REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE } from "../../settings/index.ts";
import { isInlineSeverity, REVIEW_GATE_PROSE_FIELDS, type ReviewPayload } from "../reviewSchema.ts";
import { planInlinePlacements, type InlinePlacement } from "../placement/reviewDiffPlacement.ts";
import type {
  CachedPrDiffIndex,
  CommentableRightLineRanges,
} from "../../prWorkspace/reviewDiffIndex.ts";

const INTERNAL_FAILURE_PHRASING: RegExp[] = [
  /\bstructured publish\b.*\bfailed\b/is,
  /\b\d+\/\d+ attempt\(s\)\b/i,
  /\bcheck server logs\b/i,
  /\btooling budget\b.*\b(exhausted|exceeded)\b/i,
  /\bBEGIN_SHARED_METHODOLOGY\b/,
  /\bSingle-pass review contract\b/i,
];

function containsInternalFailurePhrasing(text: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    INTERNAL_FAILURE_PHRASING.some((pattern) => pattern.test(text)),
  );
}

const GATE_PLAIN_TEXT_FORBIDDEN = /[`|<>]/;

function validateGateProseField(field: (typeof REVIEW_GATE_PROSE_FIELDS)[number], value: string) {
  if (value.trim().length === 0) {
    return ((pinnedReturn: string | null) => pinnedReturn)(`${field} must be one non-empty line`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    return ((pinnedReturn: string | null) => pinnedReturn)(`${field} must be a single line`);
  }
  if (GATE_PLAIN_TEXT_FORBIDDEN.test(value)) {
    return ((pinnedReturn: string | null) => pinnedReturn)(
      `${field} must be plain text without markdown, HTML, pipes, or backticks`,
    );
  }
  if (containsInternalFailurePhrasing(value)) {
    return ((pinnedReturn: string | null) => pinnedReturn)(
      `${field} contains banned public-output phrasing`,
    );
  }
  return ((pinnedReturn: string | null) => pinnedReturn)(null);
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

function formatSuggestedRanges(ranges: CommentableRightLineRanges) {
  const shown = ranges.slice(0, REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE);
  const suffix =
    ranges.length > REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE
      ? ` …${ranges.length - REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE} more ranges`
      : "";
  return ((pinnedReturn: string) => pinnedReturn)(
    `${shown.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ")}${suffix}`,
  );
}

function validatePlacementAnchor(
  placement: InlinePlacement,
  index: number,
  diffIndex: CachedPrDiffIndex | undefined,
  enforceInlineAnchorValidation: boolean,
) {
  if (!enforceInlineAnchorValidation)
    return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
  if (!isInlineSeverity(placement.finding.severity))
    return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
  if (placement.inlineLine != null)
    return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
  if (!diffIndex) return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
  const { finding } = placement;
  const entry = diffIndex.files.get(finding.file);
  if (!entry) {
    if (diffIndex.truncated) return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
    if (diffIndex.listPullRequestFilesIngested && diffIndex.files.size === 0)
      return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
    return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)({
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      index,
    });
  }
  if (entry.patchOmitted || entry.commentableRightLineRanges.length === 0)
    return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)(null);
  return ((pinnedReturn: AnchorFailure | null) => pinnedReturn)({
    file: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    index,
    suggestedRanges: entry.commentableRightLineRanges,
  });
}

function formatAnchorFailureRepairMessage(failures: readonly AnchorFailure[]) {
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
  lines.push("Fix all listed findings and call publish_summary again with corrected findings.");
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

export function validateReviewPayload(params: {
  payload: ReviewPayload;
  cachedDiffIndex?: CachedPrDiffIndex;
  enforceInlineAnchorValidation?: boolean;
}) {
  for (const [index, item] of params.payload.followUps.entries()) {
    if (containsInternalFailurePhrasing(item)) {
      return ((pinnedReturn: ReviewPayloadValidationResult) => pinnedReturn)({
        ok: false,
        message: `followUps[${index}] contains banned public-output phrasing`,
        anchorFailures: [],
      });
    }
  }

  for (const field of REVIEW_GATE_PROSE_FIELDS) {
    const gateError = validateGateProseField(field, params.payload[field]);
    if (gateError) {
      return ((pinnedReturn: ReviewPayloadValidationResult) => pinnedReturn)({
        ok: false,
        message: gateError,
        anchorFailures: [],
      });
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
    return ((pinnedReturn: ReviewPayloadValidationResult) => pinnedReturn)({
      ok: false,
      message: formatAnchorFailureRepairMessage(anchorFailures),
      anchorFailures,
    });
  }

  return ((pinnedReturn: ReviewPayloadValidationResult) => pinnedReturn)({ ok: true, placements });
}
