import { describe, expect, it } from "vitest";
import {
  coerceReviewPayloadInput,
  formatReviewValidationError,
  reviewEventForFindings,
  reviewPayloadSchema,
  reviewSummarySentinelForMode,
  selectInlineFindings,
} from "../src/review/reviewSchema.js";
import { REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS } from "../src/settings/index.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";

function makeFinding(severity: ReviewFinding["severity"], title: string): ReviewFinding {
  return {
    severity,
    file: "x.ts",
    startLine: 1,
    endLine: 1,
    title,
    detail: "d",
    fixPrompt: severity === "P3" ? undefined : "fix",
  };
}

describe("reviewEventForFindings", () => {
  it("REQUEST_CHANGES when P0 present", () => {
    expect(
      reviewEventForFindings([
        {
          severity: "P0",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ]),
    ).toBe("REQUEST_CHANGES");
  });

  it("REQUEST_CHANGES when P1 present", () => {
    expect(
      reviewEventForFindings([
        {
          severity: "P1",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ]),
    ).toBe("REQUEST_CHANGES");
  });

  it("COMMENT when only P2/P3", () => {
    expect(
      reviewEventForFindings([
        {
          severity: "P2",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ]),
    ).toBe("COMMENT");
  });
});

describe("selectInlineFindings", () => {
  it("returns all P0-P2 inline findings sorted by severity", () => {
    const selected = selectInlineFindings([
      makeFinding("P2", "p2"),
      makeFinding("P0", "p0"),
      makeFinding("P1", "p1"),
    ]);
    expect(selected.map((x) => x.title)).toEqual(["p0", "p1", "p2"]);
  });

  it("excludes P3", () => {
    const selected = selectInlineFindings([makeFinding("P3", "p3"), makeFinding("P1", "p1")]);
    expect(selected.map((x) => x.title)).toEqual(["p1"]);
  });

  it("accepts more than eight findings", () => {
    const findings = Array.from({ length: 12 }, (_, i) => makeFinding("P2", `bug-${i}`));
    const parsed = reviewPayloadSchema.safeParse({
      prCharacter: "Large review",
      findings,
      estimatedEffort: 3,
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings).toHaveLength(12);
      expect(selectInlineFindings(parsed.data.findings)).toHaveLength(12);
    }
  });

  it("rejects payloads above the soft findings ceiling", () => {
    const findings = Array.from({ length: 129 }, (_, i) => makeFinding("P2", `bug-${i}`));
    const parsed = reviewPayloadSchema.safeParse({
      prCharacter: "Huge review",
      findings,
      estimatedEffort: 3,
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("reviewPayloadSchema", () => {
  it("accepts optional suggestedCode and confidence fields", () => {
    const parsed = reviewPayloadSchema.safeParse({
      prCharacter: "Review with suggestion metadata",
      findings: [
        {
          severity: "P1",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "Replace guard",
          detail: "The guard allows an invalid state.",
          fixPrompt: "Replace the condition with the positive guard.",
          suggestedCode: "if (!ok) return;",
          confidence: 4,
        },
      ],
      estimatedEffort: 2,
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings[0]?.suggestedCode).toBe("if (!ok) return;");
      expect(parsed.data.findings[0]?.confidence).toBe(4);
    }
  });

  it("rejects invalid confidence and oversized suggestedCode", () => {
    for (const confidence of [0, 6]) {
      const parsed = reviewPayloadSchema.safeParse({
        prCharacter: "Review with bad confidence",
        findings: [{ ...makeFinding("P1", "bad confidence"), confidence }],
        estimatedEffort: 2,
        relevantTests: "partial",
        securityConcerns: null,
        followUps: [],
      });
      expect(parsed.success).toBe(false);
    }

    const oversized = reviewPayloadSchema.safeParse({
      prCharacter: "Review with large suggestion",
      findings: [
        {
          ...makeFinding("P1", "large suggestion"),
          suggestedCode: "x".repeat(REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS + 1),
        },
      ],
      estimatedEffort: 2,
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });
    expect(oversized.success).toBe(false);
  });
});

describe("coerceReviewPayloadInput", () => {
  it("maps CRITICAL severity alias to P0", () => {
    const { value, coerced } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [
        {
          severity: "CRITICAL",
          file: "a.ts",
          startLine: "10",
          endLine: "10",
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: "3",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coerced).toBe(true);
    const parsed = reviewPayloadSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings[0]?.severity).toBe("P0");
      expect(parsed.data.findings[0]?.startLine).toBe(10);
      expect(parsed.data.estimatedEffort).toBe(3);
    }
  });

  it("preserves finding reference when no finding field changes", () => {
    const finding = {
      severity: "P1",
      file: "a.ts",
      startLine: 10,
      endLine: 10,
      title: "t",
      detail: "d",
      fixPrompt: "fix",
    };
    const { value } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [finding],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    const out = value as { findings: unknown[] };
    expect(out.findings[0]).toBe(finding);
  });

  it("trims securityConcerns only when whitespace changes the value", () => {
    const trimmed = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no",
      securityConcerns: "  timing issue  ",
      followUps: [],
    });
    expect((trimmed.value as { securityConcerns: string }).securityConcerns).toBe("timing issue");
    expect(trimmed.coerced).toBe(true);

    const alreadyTrimmed = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [],
      estimatedEffort: 1,
      relevantTests: "no",
      securityConcerns: "plain",
      followUps: [],
    });
    expect((alreadyTrimmed.value as { securityConcerns: string }).securityConcerns).toBe("plain");
  });
});

describe("reviewFinding category", () => {
  it("accepts optional category enum and legacy payloads without category", () => {
    expect(
      reviewPayloadSchema.safeParse({
        prCharacter: "Adds retry logic.",
        findings: [
          {
            severity: "P2",
            file: "src/a.ts",
            startLine: 1,
            endLine: 1,
            title: "Missing await",
            detail: "Promise not awaited.",
            fixPrompt: "Await the promise.",
            category: "bug",
          },
        ],
        estimatedEffort: 2,
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      }).success,
    ).toBe(true);

    expect(
      reviewPayloadSchema.safeParse({
        prCharacter: "Adds retry logic.",
        findings: [
          {
            severity: "P2",
            file: "src/a.ts",
            startLine: 1,
            endLine: 1,
            title: "Missing await",
            detail: "Promise not awaited.",
            fixPrompt: "Await the promise.",
          },
        ],
        estimatedEffort: 2,
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      }).success,
    ).toBe(true);

    expect(
      reviewPayloadSchema.safeParse({
        prCharacter: "Adds retry logic.",
        findings: [
          {
            severity: "P2",
            file: "src/a.ts",
            startLine: 1,
            endLine: 1,
            title: "Missing await",
            detail: "Promise not awaited.",
            fixPrompt: "Await the promise.",
            category: "maintainability",
          },
        ],
        estimatedEffort: 2,
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      }).success,
    ).toBe(false);
  });
});

describe("reviewPayload mergeVerdict", () => {
  it("accepts optional mergeVerdict with score and rationale", () => {
    const parsed = reviewPayloadSchema.safeParse({
      prCharacter: "Adds retry logic.",
      findings: [],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
      mergeVerdict: { score: 4, rationale: "Minor issues only on this pass." },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mergeVerdict?.score).toBe(4);
      expect(parsed.data.mergeVerdict?.rationale).toBe("Minor issues only on this pass.");
    }
  });

  it("accepts payload without mergeVerdict", () => {
    const parsed = reviewPayloadSchema.safeParse({
      prCharacter: "Adds retry logic.",
      findings: [],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mergeVerdict).toBeUndefined();
    }
  });

  it("rejects mergeVerdict with out-of-range score", () => {
    for (const score of [0, 6]) {
      const parsed = reviewPayloadSchema.safeParse({
        prCharacter: "x",
        findings: [],
        estimatedEffort: 1,
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
        mergeVerdict: { score, rationale: "ok" },
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe("formatReviewValidationError", () => {
  it("lists field paths in bullet form with failureKind", () => {
    const parsed = reviewPayloadSchema.safeParse({ prCharacter: "x" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const formatted = formatReviewValidationError(parsed.error);
      expect(formatted.message).toContain("ReviewPayload validation failed:");
      expect(formatted.message).toContain("findings");
      expect(formatted.paths).toContain("findings");
      expect(formatted.failureKind).toBeTruthy();
    }
  });
});

describe("reviewSummarySentinelForMode", () => {
  it("returns the single review sentinel", () => {
    expect(reviewSummarySentinelForMode("review")).toBe("## PR Agent Review");
  });
});
