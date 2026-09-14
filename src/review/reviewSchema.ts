import * as v from "valibot";
import {
  MAX_REVIEW_FOLLOW_UPS,
  MAX_REVIEW_PAYLOAD_FINDINGS,
  REVIEW_FINDING_DETAIL_MAX_CHARS,
  REVIEW_FINDING_FIX_PROMPT_MAX_CHARS,
  REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS,
  REVIEW_FINDING_TITLE_MAX_CHARS,
  REVIEW_FOLLOW_UP_MAX_CHARS,
  REVIEW_SIZES,
  type ReviewValidationFailureKind,
} from "../settings/index.js";
import { compareReviewFindingsBySeverityFileLine } from "./findings/reviewFindingSort.js";

export { REVIEW_SUMMARY_SENTINEL } from "../settings/index.js";

export type ReviewMode = "review";

/** How a review run was triggered (automated webhook vs slash command). */
export type WorkSource = "auto" | "slash";

const severitySchema = v.picklist(["P0", "P1", "P2", "P3"]);

export const REVIEW_FINDING_CATEGORIES = ["bug", "security", "performance", "style"] as const;
export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];

export const reviewFindingEntries = {
  severity: severitySchema,
  file: v.pipe(v.string(), v.minLength(1)),
  startLine: v.pipe(v.number(), v.integer(), v.gtValue(0)),
  endLine: v.pipe(v.number(), v.integer(), v.gtValue(0)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_FINDING_TITLE_MAX_CHARS)),
  detail: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_FINDING_DETAIL_MAX_CHARS)),
  fixPrompt: v.optional(v.pipe(v.string(), v.maxLength(REVIEW_FINDING_FIX_PROMPT_MAX_CHARS))),
  suggestedCode: v.optional(
    v.pipe(v.string(), v.maxLength(REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS)),
  ),
  confidence: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5))),
  category: v.optional(v.picklist(REVIEW_FINDING_CATEGORIES)),
};

export const reviewFindingSchema = v.pipe(
  v.object(reviewFindingEntries),
  v.forward(
    v.check((f) => f.startLine <= f.endLine, "startLine must be <= endLine"),
    ["endLine"],
  ),
  v.forward(
    v.check(
      (f) => f.fixPrompt != null && f.fixPrompt.trim().length > 0,
      "fixPrompt is required for P0/P1/P2/P3 findings",
    ),
    ["fixPrompt"],
  ),
);

export function createReviewPayloadSchema() {
  return v.object({
    findings: v.pipe(v.array(reviewFindingSchema), v.maxLength(MAX_REVIEW_PAYLOAD_FINDINGS)),
    size: v.picklist(REVIEW_SIZES),
    followUps: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(REVIEW_FOLLOW_UP_MAX_CHARS))),
      v.maxLength(MAX_REVIEW_FOLLOW_UPS),
    ),
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
  lines.push(
    `Required top-level fields: findings (array, max ${MAX_REVIEW_PAYLOAD_FINDINGS}), size (${REVIEW_SIZES.join("|")}), followUps (max ${MAX_REVIEW_FOLLOW_UPS}).`,
  );
  lines.push("Each finding needs: severity, file, startLine, endLine, title, detail, fixPrompt.");
  const firstIssue = issues[0];
  const failureKind = firstIssue ? valibotIssueFailureKind(firstIssue) : "other";
  return { message: lines.join("\n"), failureKind, paths };
}

/** Severities that may post an inline review thread when a diff anchor resolves. */
export function isInlineSeverity(severity: ReviewFinding["severity"]): boolean {
  return severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3";
}

/** Severities that fail the review check run (P3 stays advisory). */
export function isCheckFailingSeverity(severity: ReviewFinding["severity"]): boolean {
  return severity === "P0" || severity === "P1" || severity === "P2";
}

export function selectInlineFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const inline = findings.filter((f) => isInlineSeverity(f.severity));
  inline.sort(compareReviewFindingsBySeverityFileLine);
  return inline;
}

export function reviewEventForFindings(findings: ReviewFinding[]): "REQUEST_CHANGES" | "COMMENT" {
  return findings.some((f) => f.severity === "P0" || f.severity === "P1")
    ? "REQUEST_CHANGES"
    : "COMMENT";
}

/** A payload whose findings are given and whose gates are neutral:
 *  size M, no follow-ups. Used for the per-batch pointer payload
 *  (publishFindingBatch) and the terminal deterministic fallback
 *  (orchestratorRun publishDeterministicSummary). */
export function reviewPayloadFromFindings(
  findings: readonly ReviewPayload["findings"][number][],
): ReviewPayload {
  return {
    findings: [...findings],
    size: "M",
    followUps: [],
  };
}
