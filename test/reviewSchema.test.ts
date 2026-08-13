import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  coerceReviewPayloadInput,
  formatReviewValidationError,
  isCheckFailingSeverity,
  isInlineSeverity,
  reviewEventForFindings,
  reviewPayloadSchema,
  REVIEW_SUMMARY_SENTINEL,
  selectInlineFindings,
} from "../src/review/reviewSchema.js";
import { REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS } from "../src/settings/index.js";
import type { ReviewFinding, ReviewMode } from "../src/review/reviewSchema.js";

function makeFinding(severity: ReviewFinding["severity"], title: string): ReviewFinding {
  return {
    severity,
    file: "x.ts",
    startLine: 1,
    endLine: 1,
    title,
    detail: "d",
    fixPrompt: "fix",
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

describe("severity helpers", () => {
  it("treats P0–P3 as inline-eligible and only P0–P2 as check-failing", () => {
    expect(isInlineSeverity("P0")).toBe(true);
    expect(isInlineSeverity("P1")).toBe(true);
    expect(isInlineSeverity("P2")).toBe(true);
    expect(isInlineSeverity("P3")).toBe(true);
    expect(isCheckFailingSeverity("P0")).toBe(true);
    expect(isCheckFailingSeverity("P1")).toBe(true);
    expect(isCheckFailingSeverity("P2")).toBe(true);
    expect(isCheckFailingSeverity("P3")).toBe(false);
  });

  it("requires fixPrompt for P3 findings", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
      prCharacter: "Overview",
      findings: [
        {
          severity: "P3",
          file: "x.ts",
          startLine: 1,
          endLine: 1,
          title: "Nit",
          detail: "minor",
        },
      ],
      size: "XS",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("selectInlineFindings", () => {
  it("returns all P0-P3 inline findings sorted by severity", () => {
    const selected = selectInlineFindings([
      makeFinding("P2", "p2"),
      makeFinding("P0", "p0"),
      makeFinding("P1", "p1"),
      makeFinding("P3", "p3"),
    ]);
    expect(selected.map((x) => x.title)).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("includes P3 with higher severities", () => {
    const selected = selectInlineFindings([makeFinding("P3", "p3"), makeFinding("P1", "p1")]);
    expect(selected.map((x) => x.title)).toEqual(["p1", "p3"]);
  });

  it("accepts more than eight findings", () => {
    const findings = Array.from({ length: 12 }, (_, i) => makeFinding("P2", `bug-${i}`));
    const parsed = v.safeParse(reviewPayloadSchema, {
      prCharacter: "Large review",
      findings,
      size: "M",
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.findings).toHaveLength(12);
      expect(selectInlineFindings(parsed.output.findings)).toHaveLength(12);
    }
  });

  it("rejects payloads above the soft findings ceiling", () => {
    const findings = Array.from({ length: 129 }, (_, i) => makeFinding("P2", `bug-${i}`));
    const parsed = v.safeParse(reviewPayloadSchema, {
      prCharacter: "Huge review",
      findings,
      size: "M",
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("reviewPayloadSchema", () => {
  it("accepts optional suggestedCode and confidence fields", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
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
      size: "S",
      relevantTests: "partial",
      securityConcerns: null,
      followUps: [],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.findings[0]?.suggestedCode).toBe("if (!ok) return;");
      expect(parsed.output.findings[0]?.confidence).toBe(4);
    }
  });

  it("rejects invalid confidence and oversized suggestedCode", () => {
    for (const confidence of [0, 6]) {
      const parsed = v.safeParse(reviewPayloadSchema, {
        prCharacter: "Review with bad confidence",
        findings: [{ ...makeFinding("P1", "bad confidence"), confidence }],
        size: "S",
        relevantTests: "partial",
        securityConcerns: null,
        followUps: [],
      });
      expect(parsed.success).toBe(false);
    }

    const oversized = v.safeParse(reviewPayloadSchema, {
      prCharacter: "Review with large suggestion",
      findings: [
        {
          ...makeFinding("P1", "large suggestion"),
          suggestedCode: "x".repeat(REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS + 1),
        },
      ],
      size: "S",
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
      size: "xl",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coerced).toBe(true);
    const parsed = v.safeParse(reviewPayloadSchema, value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.findings[0]?.severity).toBe("P0");
      expect(parsed.output.findings[0]?.startLine).toBe(10);
      expect(parsed.output.size).toBe("XL");
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
      size: "S",
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
      size: "XS",
      relevantTests: "no",
      securityConcerns: "  timing issue  ",
      followUps: [],
    });
    expect((trimmed.value as { securityConcerns: string }).securityConcerns).toBe("timing issue");
    expect(trimmed.coerced).toBe(true);

    const alreadyTrimmed = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [],
      size: "XS",
      relevantTests: "no",
      securityConcerns: "plain",
      followUps: [],
    });
    expect((alreadyTrimmed.value as { securityConcerns: string }).securityConcerns).toBe("plain");
  });
});

describe("reviewFinding violatedRule", () => {
  it("accepts optional flat .pr-agent/*.mdc path and legacy payloads without it", () => {
    const withRule = v.safeParse(reviewPayloadSchema, {
      prCharacter: "Policy violation",
      findings: [
        {
          ...makeFinding("P2", "breaks layout rule"),
          violatedRule: ".pr-agent/module-layout.mdc",
        },
      ],
      size: "S",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(withRule.success).toBe(true);
    if (withRule.success) {
      expect(withRule.output.findings[0]?.violatedRule).toBe(".pr-agent/module-layout.mdc");
    }

    const legacy = v.safeParse(reviewPayloadSchema, {
      prCharacter: "No policy field",
      findings: [makeFinding("P2", "ordinary bug")],
      size: "S",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(legacy.success).toBe(true);
    if (legacy.success) {
      expect(legacy.output.findings[0]?.violatedRule).toBeUndefined();
    }
  });

  it("rejects empty, nested, parent, and non-.pr-agent violatedRule paths", () => {
    for (const violatedRule of [
      "",
      "pr-agent/foo.mdc",
      ".pr-agent/../secrets.mdc",
      ".pr-agent/nested/foo.mdc",
      "AGENTS.md",
      ".pr-agent/foo.txt",
      ".pr-agent/..mdc",
      ".pr-agent/...mdc",
      ".pr-agent/.mdc",
      " .pr-agent/foo.mdc",
      ".pr-agent/foo.mdc ",
      null,
      `.pr-agent/${"a".repeat(67)}.mdc`,
    ]) {
      const parsed = v.safeParse(reviewPayloadSchema, {
        prCharacter: "Bad rule path",
        findings: [{ ...makeFinding("P2", "bad rule"), violatedRule }],
        size: "S",
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      });
      expect(parsed.success, `expected reject for ${JSON.stringify(violatedRule)}`).toBe(false);
    }
  });

  it("accepts the exactly-80-char violatedRule path and rejects over-max", () => {
    const exactly80 = `.pr-agent/${"a".repeat(66)}.mdc`;
    expect(exactly80.length).toBe(80);
    const accepted = v.safeParse(reviewPayloadSchema, {
      prCharacter: "Max rule path",
      findings: [{ ...makeFinding("P2", "max path"), violatedRule: exactly80 }],
      size: "S",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect(accepted.output.findings[0]?.violatedRule).toBe(exactly80);
    }
  });
});

describe("reviewFinding category", () => {
  it("accepts optional category enum and legacy payloads without category", () => {
    expect(
      v.safeParse(reviewPayloadSchema, {
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
        size: "S",
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      }).success,
    ).toBe(true);

    expect(
      v.safeParse(reviewPayloadSchema, {
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
        size: "S",
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      }).success,
    ).toBe(true);

    expect(
      v.safeParse(reviewPayloadSchema, {
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
        size: "S",
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      }).success,
    ).toBe(false);
  });
});

describe("reviewPayload unknown fields", () => {
  const baseInput = {
    prCharacter: "Adds retry logic.",
    findings: [],
    size: "S",
    relevantTests: "no" as const,
    securityConcerns: null,
    followUps: [] as string[],
  };

  it("strips legacy mergeVerdict from parsed payload", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
      ...baseInput,
      mergeVerdict: { score: 4, rationale: "Minor issues only on this pass." },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("mergeVerdict" in parsed.output).toBe(false);
    }
  });

  it("strips invalid mergeVerdict shapes", () => {
    for (const bad of [
      null,
      "just a string",
      { score: "high" },
      { rationale: 42 },
      {},
      123,
      true,
    ]) {
      const parsed = v.safeParse(reviewPayloadSchema, {
        ...baseInput,
        mergeVerdict: bad,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect("mergeVerdict" in parsed.output).toBe(false);
      }
    }
  });

  it("defaults omitted judgmentCalls to an empty array", () => {
    const parsed = v.safeParse(reviewPayloadSchema, baseInput);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.judgmentCalls).toEqual([]);
    }
  });

  it("rejects more than three judgmentCalls", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
      ...baseInput,
      judgmentCalls: ["a", "b", "c", "d"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("formatReviewValidationError", () => {
  it("lists field paths in bullet form with failureKind", () => {
    const parsed = v.safeParse(reviewPayloadSchema, { prCharacter: "x" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const formatted = formatReviewValidationError(parsed.issues);
      expect(formatted.message).toContain("ReviewPayload validation failed:");
      expect(formatted.message).toContain("findings");
      expect(formatted.paths).toContain("findings");
      expect(formatted.failureKind).toBeTruthy();
    }
  });
});

describe("REVIEW_SUMMARY_SENTINEL", () => {
  it("uses one live review mode and the general summary sentinel", () => {
    expectTypeOf<ReviewMode>().toEqualTypeOf<"review">();
    expect(REVIEW_SUMMARY_SENTINEL).toBe("## PR Agent Review");
  });
});
