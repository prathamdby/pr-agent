/** Invariant checks for prompt-cost compression candidates (string presence only). */

export type InvariantKind =
  | "structured-submission"
  | "payload-field"
  | "severity"
  | "lens-marker"
  | "fixture-evidence";

export type InvariantCheck = {
  readonly kind: InvariantKind;
  readonly label: string;
  readonly required: string;
};

export type InvariantResult = {
  readonly kind: InvariantKind;
  readonly label: string;
  readonly required: string;
  readonly passed: boolean;
};

/** Required structured submission markers on every review system prompt. */
export const STRUCTURED_SUBMISSION_MARKERS = [
  "submitReview exactly once",
  "ReviewPayload",
] as const;

/** Top-level ReviewPayload field names that must remain visible. */
export const REVIEW_PAYLOAD_FIELD_MARKERS = [
  "prCharacter",
  "findings",
  "estimatedEffort",
  "relevantTests",
  "securityConcerns",
  "followUps",
] as const;

/** Severity labels that must remain visible. */
export const SEVERITY_MARKERS = ["P0", "P1", "P2", "P3"] as const;

/** Lens-specific phrases that must survive transforms of that lens's system prompt. */
export const LENS_MARKERS: Readonly<Record<string, readonly string[]>> = {
  review: ["high-confidence, actionable bugs", "submitReview exactly once"],
  "review-security": ["security researcher", "sql-injection", "submitReview exactly once"],
  "review-quality": ["Structural simplification", "1k-line", "submitReview exactly once"],
  "review-tests": ["proposed test case", "submitReview exactly once"],
};

export function buildSystemPromptInvariants(params: { readonly lens?: string }): InvariantCheck[] {
  const checks: InvariantCheck[] = [];
  for (const marker of STRUCTURED_SUBMISSION_MARKERS) {
    checks.push({
      kind: "structured-submission",
      label: `structured:${marker}`,
      required: marker,
    });
  }
  for (const field of REVIEW_PAYLOAD_FIELD_MARKERS) {
    checks.push({
      kind: "payload-field",
      label: `field:${field}`,
      required: field,
    });
  }
  for (const severity of SEVERITY_MARKERS) {
    checks.push({
      kind: "severity",
      label: `severity:${severity}`,
      required: severity,
    });
  }
  if (params.lens && LENS_MARKERS[params.lens]) {
    for (const marker of LENS_MARKERS[params.lens]) {
      checks.push({
        kind: "lens-marker",
        label: `lens:${params.lens}:${marker}`,
        required: marker,
      });
    }
  }
  return checks;
}

export function buildFixtureEvidenceInvariants(
  evidenceLabels: readonly string[],
): InvariantCheck[] {
  return evidenceLabels.map((label) => ({
    kind: "fixture-evidence" as const,
    label: `evidence:${label}`,
    required: label,
  }));
}

export function evaluateInvariants(
  content: string,
  checks: readonly InvariantCheck[],
): {
  readonly results: readonly InvariantResult[];
  readonly allPassed: boolean;
  readonly failures: readonly InvariantResult[];
} {
  const results = checks.map((check) => ({
    kind: check.kind,
    label: check.label,
    required: check.required,
    passed: content.includes(check.required),
  }));
  const failures = results.filter((r) => !r.passed);
  return {
    results,
    allPassed: failures.length === 0,
    failures,
  };
}
