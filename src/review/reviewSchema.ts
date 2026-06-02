import { z } from "zod";
import {
  MAX_REVIEW_FOLLOW_UPS,
  MAX_REVIEW_PAYLOAD_FINDINGS,
  REVIEW_EFFORT_MAX,
  REVIEW_EFFORT_MIN,
  REVIEW_FINDING_DETAIL_MAX_CHARS,
  REVIEW_FINDING_FIX_PROMPT_MAX_CHARS,
  REVIEW_FINDING_TITLE_MAX_CHARS,
  REVIEW_FOLLOW_UP_MAX_CHARS,
  REVIEW_OVERVIEW_MAX_CHARS,
  REVIEW_SECURITY_CONCERNS_MAX_CHARS,
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  QUALITY_REVIEW_SUMMARY_SENTINEL,
  type ReviewValidationFailureKind,
} from "../settings/index.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import { fixDoubleEscapedString } from "../agent/fixDoubleEscapedString.js";

export {
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
  QUALITY_REVIEW_SUMMARY_SENTINEL,
} from "../settings/index.js";

export type ReviewMode = "review" | "review-security" | "review-quality";

/** How a review run was triggered (automated webhook vs slash command). */
export type WorkSource = "auto" | "slash";

export function reviewSummarySentinelForMode(mode: ReviewMode): string {
  switch (mode) {
    case "review-security":
      return SECURITY_REVIEW_SUMMARY_SENTINEL;
    case "review-quality":
      return QUALITY_REVIEW_SUMMARY_SENTINEL;
    case "review":
      return REVIEW_SUMMARY_SENTINEL;
  }
  const exhaustive: never = mode;
  return exhaustive;
}

export function reviewRetrySlashCommandForMode(mode: ReviewMode): string {
  switch (mode) {
    case "review-security":
      return "/review-security";
    case "review-quality":
      return "/review-quality";
    case "review":
      return "/review";
  }
  const exhaustive: never = mode;
  return exhaustive;
}

const severitySchema = z.enum(["P0", "P1", "P2", "P3"]);

const reviewFindingSchema = z
  .object({
    severity: severitySchema,
    file: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    title: z.string().min(1).max(REVIEW_FINDING_TITLE_MAX_CHARS),
    detail: z.string().min(1).max(REVIEW_FINDING_DETAIL_MAX_CHARS),
    fixPrompt: z.string().max(REVIEW_FINDING_FIX_PROMPT_MAX_CHARS).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.startLine > f.endLine) {
      ctx.addIssue({
        code: "custom",
        message: "startLine must be <= endLine",
        path: ["endLine"],
      });
    }
    if (f.severity !== "P3" && (!f.fixPrompt || f.fixPrompt.trim().length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "fixPrompt is required for P0/P1/P2 findings",
        path: ["fixPrompt"],
      });
    }
  });

export function createReviewPayloadSchema() {
  return z.object({
    prCharacter: z.string().min(1).max(REVIEW_OVERVIEW_MAX_CHARS),
    findings: z.array(reviewFindingSchema).max(MAX_REVIEW_PAYLOAD_FINDINGS),
    estimatedEffort: z.number().int().min(REVIEW_EFFORT_MIN).max(REVIEW_EFFORT_MAX),
    relevantTests: z.enum(["yes", "no", "partial"]),
    securityConcerns: z.string().max(REVIEW_SECURITY_CONCERNS_MAX_CHARS).nullable(),
    followUps: z.array(z.string().max(REVIEW_FOLLOW_UP_MAX_CHARS)).max(MAX_REVIEW_FOLLOW_UPS),
  });
}

export const reviewPayloadSchema = createReviewPayloadSchema();

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

export type ReviewPublishContext = {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
};

export const REVIEW_PAYLOAD_MINIMAL_EXAMPLE = {
  prCharacter: "Adds retry logic to the webhook dispatcher.",
  findings: [
    {
      severity: "P1",
      file: "src/handler.ts",
      startLine: 42,
      endLine: 42,
      title: "Missing await on promise",
      detail: "The handler returns before the async work completes.",
      fixPrompt: "Await the promise before returning so errors propagate.",
    },
  ],
  estimatedEffort: 2,
  relevantTests: "partial",
  securityConcerns: null,
  followUps: [],
} as const;

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

function stripWholeStringCodeFence(value: string): { text: string; stripped: boolean } {
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
  return { text: trimmed, changed: doubleEscaped || stripped || trimmed !== raw };
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

function unwrapPayloadEnvelope(raw: unknown): { value: unknown; coercions: string[] } {
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

type FindingDraft = {
  readonly raw: Record<string, unknown>;
  value: Record<string, unknown>;
  mutated: boolean;
  readonly coercions: string[];
};

function makeFindingDraft(raw: Record<string, unknown>, coercions: string[]): FindingDraft {
  return { raw, value: raw, mutated: false, coercions };
}

function touchFindingDraft(draft: FindingDraft): void {
  if (draft.mutated) return;
  draft.value = { ...draft.raw };
  draft.mutated = true;
}

function setFindingField(
  draft: FindingDraft,
  field: string,
  value: unknown,
  coercion: string,
): void {
  touchFindingDraft(draft);
  draft.value[field] = value;
  draft.coercions.push(coercion);
}

function coerceFindingLineAlias(draft: FindingDraft): void {
  if (!("line" in draft.raw) || "startLine" in draft.raw) return;
  const line = coercePositiveInt(draft.raw.line);
  if (line == null || line <= 0) return;
  touchFindingDraft(draft);
  draft.value.startLine = line;
  draft.value.endLine = line;
  draft.coercions.push("finding_line_to_start_end");
}

function coerceFindingLinesArray(draft: FindingDraft): void {
  const lines = draft.raw.lines;
  if (!Array.isArray(lines) || lines.length < 1) return;
  const start = coercePositiveInt(lines[0]);
  const end = lines.length >= 2 ? coercePositiveInt(lines[1]) : start;
  if (start == null || start <= 0 || end == null || end <= 0) return;
  touchFindingDraft(draft);
  draft.value.startLine = start;
  draft.value.endLine = end;
  draft.coercions.push("finding_lines_array_to_start_end");
}

function coerceFindingSeverityField(draft: FindingDraft): void {
  if (!("severity" in draft.raw)) return;
  const coerced = coerceSeverity(draft.raw.severity);
  if (!coerced || coerced === draft.raw.severity) return;
  setFindingField(draft, "severity", coerced, "finding_severity_alias");
}

function coerceFindingNumberField(
  draft: FindingDraft,
  field: "startLine" | "endLine",
  coercion: string,
): void {
  if (!(field in draft.raw)) return;
  const coerced = coercePositiveInt(draft.raw[field]);
  if (coerced == null || coerced <= 0 || coerced === draft.raw[field]) return;
  setFindingField(draft, field, coerced, coercion);
}

function coerceFindingTextFields(
  draft: FindingDraft,
  fields: readonly [
    "file" | "title" | "detail" | "fixPrompt",
    ...Array<"file" | "title" | "detail" | "fixPrompt">,
  ],
): void {
  for (const field of fields) {
    const rawValue = draft.raw[field];
    if (typeof rawValue !== "string") continue;
    const { text, changed } = coerceReviewTextField(rawValue, `finding_${field}`, draft.coercions);
    if (!changed) continue;
    touchFindingDraft(draft);
    draft.value[field] = text;
  }
}

function removeEmptyFixPrompt(draft: FindingDraft): void {
  if (!("fixPrompt" in draft.raw) || typeof draft.raw.fixPrompt !== "string") return;
  const rawFix = (draft.mutated ? draft.value.fixPrompt : draft.raw.fixPrompt) as string;
  if (rawFix.trim().length > 0) return;
  touchFindingDraft(draft);
  delete draft.value.fixPrompt;
  draft.coercions.push("finding_fixPrompt_empty_removed");
}

function coerceFinding(raw: unknown, coercions: string[]): unknown {
  if (typeof raw !== "object" || raw == null) return raw;
  const draft = makeFindingDraft(raw as Record<string, unknown>, coercions);
  coerceFindingLineAlias(draft);
  coerceFindingLinesArray(draft);
  coerceFindingSeverityField(draft);
  coerceFindingNumberField(draft, "startLine", "finding_startLine_number");
  coerceFindingNumberField(draft, "endLine", "finding_endLine_number");
  coerceFindingTextFields(draft, ["file", "title", "detail", "fixPrompt"]);
  removeEmptyFixPrompt(draft);
  return draft.mutated ? draft.value : raw;
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

  if ("findings" in input && input.findings != null && !Array.isArray(input.findings)) {
    if (typeof input.findings === "object") {
      input.findings = [input.findings];
      coercions.push("findings_object_to_array");
    }
  }

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
  }

  return { value: input, coerced: coercions.length > 0, coercions };
}

function zodIssueFailureKind(issue: z.ZodIssue): ReviewValidationFailureKind {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? "missing_field" : "wrong_type";
    case "invalid_value":
      return "enum_mismatch";
    case "too_small":
      return issue.origin === "string" ? "string_too_short" : "out_of_range";
    case "too_big":
      return issue.origin === "array" ? "array_too_long" : "out_of_range";
    case "custom":
      return "custom_predicate";
    default:
      return "other";
  }
}

export function formatReviewValidationError(error: z.ZodError): {
  message: string;
  failureKind: ReviewValidationFailureKind;
  paths: string[];
} {
  const paths: string[] = [];
  const lines = ["ReviewPayload validation failed:"];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    paths.push(path);
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push(
    `Required top-level fields: prCharacter, findings (array, max ${MAX_REVIEW_PAYLOAD_FINDINGS}), estimatedEffort (${REVIEW_EFFORT_MIN}-${REVIEW_EFFORT_MAX}), relevantTests (yes|no|partial), securityConcerns (string|null), followUps (max ${MAX_REVIEW_FOLLOW_UPS}).`,
  );
  lines.push(
    "Each P0/P1/P2 finding needs: severity, file, startLine, endLine, title, detail, fixPrompt.",
  );
  const firstIssue = error.issues[0];
  const failureKind = firstIssue ? zodIssueFailureKind(firstIssue) : "other";
  return { message: lines.join("\n"), failureKind, paths };
}

export function isInlineSeverity(severity: ReviewFinding["severity"]): boolean {
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
