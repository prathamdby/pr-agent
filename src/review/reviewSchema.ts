import * as v from "valibot";
import {
  MAX_REVIEW_FOLLOW_UPS,
  MAX_REVIEW_PAYLOAD_FINDINGS,
  REVIEW_EFFORT_MAX,
  REVIEW_EFFORT_MIN,
  REVIEW_FINDING_DETAIL_MAX_CHARS,
  REVIEW_FINDING_FIX_PROMPT_MAX_CHARS,
  REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS,
  REVIEW_FINDING_TITLE_MAX_CHARS,
  REVIEW_FINDING_VIOLATED_RULE_MAX_CHARS,
  REVIEW_FOLLOW_UP_MAX_CHARS,
  REVIEW_OVERVIEW_MAX_CHARS,
  REVIEW_SECURITY_CONCERNS_MAX_CHARS,
  type ReviewValidationFailureKind,
} from "../settings/index.js";
import { compareReviewFindingsBySeverityFileLine } from "./findings/reviewFindingSort.js";
import { fixDoubleEscapedString } from "../agent/tools/fixDoubleEscapedString.js";

export { REVIEW_SUMMARY_SENTINEL } from "../settings/index.js";

export type ReviewMode = "review";

/** How a review run was triggered (automated webhook vs slash command). */
export type WorkSource = "auto" | "slash";

const severitySchema = v.picklist(["P0", "P1", "P2", "P3"]);

export const REVIEW_FINDING_CATEGORIES = ["bug", "security", "performance", "style"] as const;
export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];

const VIOLATED_RULE_PATH_RE = /^\.pr-agent\/[A-Za-z0-9][A-Za-z0-9._-]*\.mdc$/;

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
  violatedRule: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_FINDING_VIOLATED_RULE_MAX_CHARS)),
  ),
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
  v.forward(
    v.check(
      (f) => f.violatedRule == null || VIOLATED_RULE_PATH_RE.test(f.violatedRule),
      "violatedRule must be a flat .pr-agent/<name>.mdc path",
    ),
    ["violatedRule"],
  ),
);

export function createReviewPayloadSchema() {
  return v.object({
    prCharacter: v.pipe(v.string(), v.minLength(1), v.maxLength(REVIEW_OVERVIEW_MAX_CHARS)),
    findings: v.pipe(v.array(reviewFindingSchema), v.maxLength(MAX_REVIEW_PAYLOAD_FINDINGS)),
    estimatedEffort: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(REVIEW_EFFORT_MIN),
      v.maxValue(REVIEW_EFFORT_MAX),
    ),
    relevantTests: v.picklist(["yes", "no", "partial"]),
    securityConcerns: v.nullable(
      v.pipe(v.string(), v.maxLength(REVIEW_SECURITY_CONCERNS_MAX_CHARS)),
    ),
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

const SEVERITY_ALIAS: Record<string, ReviewFinding["severity"]> = {
  CRITICAL: "P0",
  HIGH: "P1",
  MEDIUM: "P2",
  LOW: "P3",
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
  "1": "P0",
  "2": "P1",
  "3": "P2",
  "4": "P3",
};

const SEVERITY_INTEGER_MAP: Record<number, ReviewFinding["severity"]> = {
  0: "P0",
  1: "P0",
  2: "P1",
  3: "P2",
  4: "P3",
};

function coercePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }
  return undefined;
}

function stripWholeStringCodeFence(value: string): {
  text: string;
  stripped: boolean;
} {
  const trimmed = value.trim();
  const fenceMatch = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (!fenceMatch) return { text: value, stripped: false };
  return { text: fenceMatch[1].trim(), stripped: true };
}

function coerceReviewTextField(
  raw: string,
  coercionPrefix: string,
  coercions: string[],
): { text: string; changed: boolean } {
  const { text: unescaped, fixed: doubleEscaped } = fixDoubleEscapedString(raw);
  const { text, stripped } = stripWholeStringCodeFence(unescaped);
  const trimmed = text.trim();
  if (doubleEscaped) coercions.push(`${coercionPrefix}_double_escape`);
  if (stripped) coercions.push(`${coercionPrefix}_fence_strip`);
  else if (trimmed !== raw) coercions.push(`${coercionPrefix}_trim`);
  return {
    text: trimmed,
    changed: doubleEscaped || stripped || trimmed !== raw,
  };
}

function coerceSeverity(value: unknown): ReviewFinding["severity"] | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return SEVERITY_INTEGER_MAP[value];
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const direct = SEVERITY_ALIAS[trimmed.toUpperCase()];
  if (direct) return direct;
  const pMatch = /^P([0-3])\b/i.exec(trimmed);
  if (pMatch) return `P${pMatch[1]}` as ReviewFinding["severity"];
  const wordMatch = /^(CRITICAL|HIGH|MEDIUM|LOW)\b/i.exec(trimmed);
  if (wordMatch) return SEVERITY_ALIAS[wordMatch[1].toUpperCase()];
  return undefined;
}

function unwrapPayloadEnvelope(raw: unknown): {
  value: unknown;
  coercions: string[];
} {
  if (typeof raw !== "object" || raw == null) return { value: raw, coercions: [] };
  const obj = raw as Record<string, unknown>;
  for (const key of ["review", "payload", "result", "data"] as const) {
    const nested = obj[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedObj = nested as Record<string, unknown>;
      if ("findings" in nestedObj || "prCharacter" in nestedObj) {
        return { value: nested, coercions: [`unwrap_${key}`] };
      }
    }
  }
  return { value: raw, coercions: [] };
}

function coerceFinding(raw: unknown, coercions: string[]): unknown {
  if (typeof raw !== "object" || raw == null) return raw;
  const r = raw as Record<string, unknown>;
  let mutated = false;
  let f: Record<string, unknown> = r;

  const touch = (): void => {
    if (!mutated) {
      f = { ...r };
      mutated = true;
    }
  };

  if ("line" in r && !("startLine" in r)) {
    const n = coercePositiveInt(r.line);
    if (n != null && n > 0) {
      touch();
      f.startLine = n;
      f.endLine = n;
      coercions.push("finding_line_to_start_end");
    }
  }

  if ("lines" in r && Array.isArray(r.lines) && r.lines.length >= 1) {
    const start = coercePositiveInt(r.lines[0]);
    const end = r.lines.length >= 2 ? coercePositiveInt(r.lines[1]) : start;
    if (start != null && start > 0 && end != null && end > 0) {
      touch();
      f.startLine = start;
      f.endLine = end;
      coercions.push("finding_lines_array_to_start_end");
    }
  }

  if ("severity" in r) {
    const coerced = coerceSeverity(r.severity);
    if (coerced && coerced !== r.severity) {
      touch();
      f.severity = coerced;
      coercions.push("finding_severity_alias");
    }
  }
  if ("startLine" in r) {
    const n = coercePositiveInt(r.startLine);
    if (n != null && n > 0 && n !== r.startLine) {
      touch();
      f.startLine = n;
      coercions.push("finding_startLine_number");
    }
  }
  if ("endLine" in r) {
    const n = coercePositiveInt(r.endLine);
    if (n != null && n > 0 && n !== r.endLine) {
      touch();
      f.endLine = n;
      coercions.push("finding_endLine_number");
    }
  }
  if ("confidence" in r) {
    const n = coercePositiveInt(r.confidence);
    if (n != null && n >= 1 && n <= 5 && n !== r.confidence) {
      touch();
      f.confidence = n;
      coercions.push("finding_confidence_number");
    }
  }
  for (const field of ["file", "title"] as const) {
    if (field in r && typeof r[field] === "string") {
      const { text, changed } = coerceReviewTextField(r[field], `finding_${field}`, coercions);
      if (changed) {
        touch();
        f[field] = text;
      }
    }
  }
  for (const field of ["detail", "fixPrompt"] as const) {
    if (field in r && typeof r[field] === "string") {
      const { text, changed } = coerceReviewTextField(r[field], `finding_${field}`, coercions);
      if (changed) {
        touch();
        f[field] = text;
      }
    }
  }
  if ("fixPrompt" in r && typeof r.fixPrompt === "string") {
    const rawFix = (mutated ? f.fixPrompt : r.fixPrompt) as string;
    if (rawFix.trim().length === 0) {
      touch();
      delete f.fixPrompt;
      coercions.push("finding_fixPrompt_empty_removed");
    }
  }
  return mutated ? f : raw;
}

export function coerceReviewPayloadInput(raw: unknown): {
  value: unknown;
  coerced: boolean;
  coercions: string[];
} {
  const coercions: string[] = [];
  const unwrapped = unwrapPayloadEnvelope(raw);
  coercions.push(...unwrapped.coercions);

  if (typeof unwrapped.value !== "object" || unwrapped.value == null) {
    return { value: unwrapped.value, coerced: coercions.length > 0, coercions };
  }

  const input = { ...(unwrapped.value as Record<string, unknown>) };

  if ("prCharacter" in input && typeof input.prCharacter === "string") {
    const { text, changed } = coerceReviewTextField(input.prCharacter, "prCharacter", coercions);
    if (changed) {
      input.prCharacter = text;
    }
  }
  if ("estimatedEffort" in input) {
    const n = coercePositiveInt(input.estimatedEffort);
    if (n != null && n !== input.estimatedEffort) {
      input.estimatedEffort = n;
      coercions.push("estimatedEffort_number");
    }
  }
  if ("securityConcerns" in input && typeof input.securityConcerns === "string") {
    const { text, changed } = coerceReviewTextField(
      input.securityConcerns,
      "securityConcerns",
      coercions,
    );
    if (changed) {
      input.securityConcerns = text;
    }
  }
  if (Array.isArray(input.followUps)) {
    input.followUps = input.followUps.map((item) => {
      if (typeof item !== "string") return item;
      const { text, changed } = coerceReviewTextField(item, "followUp", coercions);
      return changed ? text : item;
    });
  }
  if (Array.isArray(input.findings)) {
    input.findings = input.findings.map((item) => coerceFinding(item, coercions));
  } else if (typeof input.findings === "object" && input.findings != null) {
    // A single finding object still needs its domain coercions here; the
    // generic object_wrapped_as_array repair does the wrapping afterwards.
    // Coercing only the array form left shape-plus-domain errors unparseable.
    input.findings = coerceFinding(input.findings, coercions);
  }

  return { value: input, coerced: coercions.length > 0, coercions };
}

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
    `Required top-level fields: prCharacter, findings (array, max ${MAX_REVIEW_PAYLOAD_FINDINGS}), estimatedEffort (${REVIEW_EFFORT_MIN}-${REVIEW_EFFORT_MAX}), relevantTests (yes|no|partial), securityConcerns (string|null), followUps (max ${MAX_REVIEW_FOLLOW_UPS}).`,
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

export function normalizeReviewPayload(raw: ReviewPayload): ReviewPayload {
  const security =
    raw.securityConcerns == null || raw.securityConcerns.trim().length === 0
      ? null
      : raw.securityConcerns.trim();
  return { ...raw, securityConcerns: security };
}
