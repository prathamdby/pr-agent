import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { toJsonSchema } from "@valibot/to-json-schema";
import {
  createReviewPayloadSchema,
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
      findings,
      size: "M",
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
      findings,
      size: "M",
      followUps: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("reviewPayloadSchema", () => {
  it("accepts optional suggestedCode and confidence fields", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
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
        findings: [{ ...makeFinding("P1", "bad confidence"), confidence }],
        size: "S",
        followUps: [],
      });
      expect(parsed.success).toBe(false);
    }

    const oversized = v.safeParse(reviewPayloadSchema, {
      findings: [
        {
          ...makeFinding("P1", "large suggestion"),
          suggestedCode: "x".repeat(REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS + 1),
        },
      ],
      size: "S",
      followUps: [],
    });
    expect(oversized.success).toBe(false);
  });
});

describe("reviewFinding leftover violatedRule", () => {
  it("drops leftover violatedRule and still accepts the payload", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
      findings: [
        {
          ...makeFinding("P2", "ordinary bug"),
          violatedRule: ".pr-agent/testing.mdc",
        },
      ],
      size: "S",
      followUps: [],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.findings[0]).not.toHaveProperty("violatedRule");
    expect(parsed.output.findings[0]?.title).toBe("ordinary bug");
  });

  it("omits violatedRule from the static review payload schema", () => {
    const schema = toJsonSchema(createReviewPayloadSchema(), { errorMode: "ignore" });
    expect(JSON.stringify(schema)).not.toContain("violatedRule");
  });
});

describe("reviewFinding category", () => {
  it("accepts optional category enum and legacy payloads without category", () => {
    expect(
      v.safeParse(reviewPayloadSchema, {
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
        followUps: [],
      }).success,
    ).toBe(true);

    expect(
      v.safeParse(reviewPayloadSchema, {
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
        followUps: [],
      }).success,
    ).toBe(true);

    expect(
      v.safeParse(reviewPayloadSchema, {
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
        followUps: [],
      }).success,
    ).toBe(false);
  });
});

describe("reviewPayload unknown fields", () => {
  const baseInput = {
    findings: [],
    size: "S",
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
});

describe("formatReviewValidationError", () => {
  it("lists field paths in bullet form with failureKind", () => {
    const parsed = v.safeParse(reviewPayloadSchema, { size: "S" });
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
