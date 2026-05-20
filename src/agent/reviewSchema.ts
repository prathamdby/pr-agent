import { z } from "zod";

export const REVIEW_SUMMARY_SENTINEL = "## PR Agent Review";
export const SECURITY_REVIEW_SUMMARY_SENTINEL = "## PR Agent Security Review";

export type ReviewMode = "review" | "review-security";

export function reviewSummarySentinelForMode(mode: ReviewMode): string {
  return mode === "review-security" ? SECURITY_REVIEW_SUMMARY_SENTINEL : REVIEW_SUMMARY_SENTINEL;
}

const severitySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const reviewFindingSchema = z
  .object({
    severity: severitySchema,
    file: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    title: z.string().min(1),
    detail: z.string().min(1),
    fixPrompt: z.string().optional(),
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

export const reviewPayloadSchema = z.object({
  prCharacter: z.string().min(1),
  findings: z.array(reviewFindingSchema).max(8),
  estimatedEffort: z.number().int().min(1).max(5),
  relevantTests: z.enum(["yes", "no", "partial"]),
  securityConcerns: z.string().nullable(),
  followUps: z.array(z.string()).max(5),
});

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
};

function coercePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function coerceSeverity(value: unknown): ReviewFinding["severity"] | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toUpperCase();
  return SEVERITY_ALIAS[key];
}

function coerceFinding(raw: unknown): unknown {
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

  if ("severity" in r) {
    const coerced = coerceSeverity(r.severity);
    if (coerced && coerced !== r.severity) {
      touch();
      f.severity = coerced;
    }
  }
  if ("startLine" in r) {
    const n = coercePositiveInt(r.startLine);
    if (n != null && n > 0 && n !== r.startLine) {
      touch();
      f.startLine = n;
    }
  }
  if ("endLine" in r) {
    const n = coercePositiveInt(r.endLine);
    if (n != null && n > 0 && n !== r.endLine) {
      touch();
      f.endLine = n;
    }
  }
  if ("file" in r && typeof r.file === "string") {
    const trimmed = r.file.trim();
    if (trimmed !== r.file) {
      touch();
      f.file = trimmed;
    }
  }
  if ("title" in r && typeof r.title === "string") {
    const trimmed = r.title.trim();
    if (trimmed !== r.title) {
      touch();
      f.title = trimmed;
    }
  }
  if ("detail" in r && typeof r.detail === "string") {
    const trimmed = r.detail.trim();
    if (trimmed !== r.detail) {
      touch();
      f.detail = trimmed;
    }
  }
  if ("fixPrompt" in r && typeof r.fixPrompt === "string") {
    const trimmed = r.fixPrompt.trim();
    if (trimmed.length === 0) {
      touch();
      delete f.fixPrompt;
    } else if (trimmed !== r.fixPrompt) {
      touch();
      f.fixPrompt = trimmed;
    }
  }

  return mutated ? f : raw;
}

export function coerceReviewPayloadInput(raw: unknown): { value: unknown; coerced: boolean } {
  if (typeof raw !== "object" || raw == null) return { value: raw, coerced: false };
  const input = { ...(raw as Record<string, unknown>) };
  let coerced = false;

  if ("prCharacter" in input && typeof input.prCharacter === "string") {
    input.prCharacter = input.prCharacter.trim();
    coerced = true;
  }
  if ("estimatedEffort" in input) {
    const n = coercePositiveInt(input.estimatedEffort);
    if (n != null && n !== input.estimatedEffort) {
      input.estimatedEffort = n;
      coerced = true;
    }
  }
  if ("securityConcerns" in input && typeof input.securityConcerns === "string") {
    const trimmed = input.securityConcerns.trim();
    if (trimmed !== input.securityConcerns) {
      input.securityConcerns = trimmed;
      coerced = true;
    }
  }
  if (Array.isArray(input.findings)) {
    input.findings = input.findings.map((item) => {
      const next = coerceFinding(item);
      if (next !== item) coerced = true;
      return next;
    });
  }

  return { value: input, coerced };
}

export function formatReviewValidationError(error: z.ZodError): string {
  const lines = ["ReviewPayload validation failed:"];
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push(
    "Required top-level fields: prCharacter, findings (max 8), estimatedEffort (1-5), relevantTests (yes|no|partial), securityConcerns (string|null), followUps (max 5).",
  );
  lines.push(
    "Each P0/P1/P2 finding needs: severity, file, startLine, endLine, title, detail, fixPrompt.",
  );
  return lines.join("\n");
}

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export function isInlineSeverity(severity: ReviewFinding["severity"]): boolean {
  return severity === "P0" || severity === "P1" || severity === "P2";
}

export function selectInlineFindings(
  findings: ReviewFinding[],
  maxFindings: number,
): ReviewFinding[] {
  const inline = findings.filter((f) => isInlineSeverity(f.severity));
  inline.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return inline.slice(0, maxFindings);
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
