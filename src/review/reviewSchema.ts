import * as v from "valibot";
import { severityDefinitionText } from "../prompts/shared/safety.ts";
import {
  MAX_REVIEW_FOLLOW_UPS,
  MAX_REVIEW_PAYLOAD_FINDINGS,
  REVIEW_FINDING_DETAIL_MAX_CHARS,
  REVIEW_FINDING_FIX_PROMPT_MAX_CHARS,
  REVIEW_FINDING_SEVERITY_RATIONALE_MAX_CHARS,
  REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS,
  REVIEW_FINDING_TITLE_MAX_CHARS,
  REVIEW_FOLLOW_UP_MAX_CHARS,
  REVIEW_GATE_PROSE_MAX_CHARS,
  REVIEW_GATE_PROSE_UNASSESSED,
  REVIEW_RISK_PATH_PATTERNS,
  REVIEW_SEVERITY_RANK,
  REVIEW_SIZES,
  type ReviewValidationFailureKind,
} from "../settings/index.ts";

export { REVIEW_SUMMARY_SENTINEL } from "../settings/index.ts";

export type ReviewMode = "review";

export type WorkSource = "auto" | "slash";

const severitySchema = v.picklist(["P0", "P1", "P2", "P3"]);

export const REVIEW_FINDING_CATEGORIES = ["bug", "security", "performance", "style"] as const;
export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];

export const reviewFindingEntries = {
  severity: v.pipe(severitySchema, v.description(`Final severity. ${severityDefinitionText()}`)),
  severityRationale: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(REVIEW_FINDING_SEVERITY_RATIONALE_MAX_CHARS),
      v.description(
        "One short private sentence for the final severity. Stored with the finding and never rendered.",
      ),
    ),
  ),
  file: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("Repository-relative path of the file the finding anchors to."),
  ),
  startLine: v.pipe(
    v.number(),
    v.integer(),
    v.gtValue(0),
    v.description("First anchored line at the reviewed head, 1-based."),
  ),
  endLine: v.pipe(
    v.number(),
    v.integer(),
    v.gtValue(0),
    v.description("Last anchored line, at or after startLine."),
  ),
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REVIEW_FINDING_TITLE_MAX_CHARS),
    v.description("One-line statement of the defect."),
  ),
  detail: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REVIEW_FINDING_DETAIL_MAX_CHARS),
    v.description(
      "Two or three short sentences stating the trigger, the observable consequence, the proving line, the broken rule or invariant, and any unconfirmed step, without restating the diff or fixPrompt.",
    ),
  ),
  fixPrompt: v.pipe(
    v.string(),
    v.maxLength(REVIEW_FINDING_FIX_PROMPT_MAX_CHARS),
    v.description(
      "One or two standalone sentences naming the defect and the fix direction, without a file or line header.",
    ),
  ),
  suggestedCode: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS),
      v.description(
        "Exact replacement for startLine..endLine. Omit when the fix touches other lines.",
      ),
    ),
  ),
  confidence: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(5),
      v.description("How sure you are the defect is real, 1 (guess) to 5 (proven)."),
    ),
  ),
  category: v.optional(v.picklist(REVIEW_FINDING_CATEGORIES)),
};

export const reviewFindingSchema = v.pipe(
  v.object(reviewFindingEntries),
  v.forward(
    v.check((f) => f.startLine <= f.endLine, "startLine must be <= endLine"),
    ["endLine"],
  ),
  v.forward(
    v.check((f) => f.fixPrompt.trim().length > 0, "fixPrompt is required for P0/P1/P2/P3 findings"),
    ["fixPrompt"],
  ),
);

export const REVIEW_PUBLISH_SUMMARY_FIELDS = [
  "size",
  "followUps",
  "mergeability",
  "blastRadius",
] as const;

export const REVIEW_GATE_PROSE_FIELDS = ["mergeability", "blastRadius"] as const;

const reviewGateProseSchema = v.pipe(v.string(), v.maxLength(REVIEW_GATE_PROSE_MAX_CHARS));

export function createReviewPayloadSchema() {
  return v.object({
    findings: v.pipe(v.array(reviewFindingSchema), v.maxLength(MAX_REVIEW_PAYLOAD_FINDINGS)),
    size: v.picklist(REVIEW_SIZES),
    followUps: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(REVIEW_FOLLOW_UP_MAX_CHARS))),
      v.maxLength(MAX_REVIEW_FOLLOW_UPS),
    ),
    mergeability: reviewGateProseSchema,
    blastRadius: reviewGateProseSchema,
  });
}

export const reviewPayloadSchema = createReviewPayloadSchema();

export type ReviewFinding = v.InferOutput<typeof reviewFindingSchema>;
export type ReviewPayload = v.InferOutput<typeof reviewPayloadSchema>;

export type ReviewPublishContext = {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  hasDescriptionReviewMap: boolean;
};

const BASE_TYPE_ISSUE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "null",
  "undefined",
]);

function valibotIssueFailureKind(issue: v.GenericIssue): ReviewValidationFailureKind {
  if (issue.input === undefined) return "missing_field";
  switch (issue.type) {
    case "picklist":
    case "literal":
      return "enum_mismatch";
    case "min_length":
      return typeof issue.input === "string" ? "string_too_short" : "out_of_range";
    case "max_length":
      return Array.isArray(issue.input) ? "array_too_long" : "out_of_range";
    case "min_value":
    case "max_value":
      return "out_of_range";
    case "check":
      return "custom_predicate";
    default:
      return BASE_TYPE_ISSUE_TYPES.has(issue.type) ? "wrong_type" : "other";
  }
}

export function formatReviewValidationError(issues: readonly v.GenericIssue[]): {
  message: string;
  failureKind: ReviewValidationFailureKind;
  paths: string[];
} {
  const paths: string[] = [];
  const lines = ["ReviewPayload validation failed:"];
  for (const issue of issues) {
    const path = v.getDotPath(issue) ?? "(root)";
    paths.push(path);
    lines.push(`- ${path}: ${issue.message}`);
  }
  const firstIssue = issues[0];
  const failureKind = firstIssue ? valibotIssueFailureKind(firstIssue) : "other";
  return { message: lines.join("\n"), failureKind, paths };
}

export function isInlineSeverity(severity: ReviewFinding["severity"]): boolean {
  return severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3";
}

const REVIEW_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

type SeverityRank = (typeof REVIEW_SEVERITY_RANK)[ReviewFinding["severity"]];

function looserRank(left: SeverityRank, right: SeverityRank): SeverityRank {
  return left > right ? left : right;
}

export function cappedFindingSeverity(params: {
  readonly severity: ReviewFinding["severity"];
  readonly testsLens: boolean;
  readonly anchorPath: string;
  readonly judged: boolean;
}): ReviewFinding["severity"] {
  let rank: SeverityRank = REVIEW_SEVERITY_RANK[params.severity];
  if (params.testsLens) rank = looserRank(rank, REVIEW_SEVERITY_RANK.P2);
  if (REVIEW_RISK_PATH_PATTERNS.test.some((pattern) => pattern.test(params.anchorPath))) {
    rank = looserRank(rank, REVIEW_SEVERITY_RANK.P2);
  }
  if (!params.judged) rank = looserRank(rank, REVIEW_SEVERITY_RANK.P1);
  return REVIEW_SEVERITIES[rank] ?? params.severity;
}

export function isCheckFailingSeverity(
  severity: ReviewFinding["severity"],
  threshold: ReviewFinding["severity"],
): boolean {
  return REVIEW_SEVERITY_RANK[severity] <= REVIEW_SEVERITY_RANK[threshold];
}

export function reviewPayloadFromFindings(
  findings: readonly ReviewPayload["findings"][number][],
): ReviewPayload {
  return {
    findings: [...findings],
    size: "M",
    followUps: [],
    mergeability: REVIEW_GATE_PROSE_UNASSESSED,
    blastRadius: REVIEW_GATE_PROSE_UNASSESSED,
  };
}
