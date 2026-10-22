import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { toJsonSchema } from "@valibot/to-json-schema";
import {
  createReviewPayloadSchema,
  formatReviewValidationError,
  cappedFindingSeverity,
  isCheckFailingSeverity,
  isInlineSeverity,
  reviewPayloadFromFindings,
  reviewPayloadSchema,
  REVIEW_SUMMARY_SENTINEL,
} from "../src/review/reviewSchema.ts";
import {
  REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS,
  REVIEW_GATE_PROSE_MAX_CHARS,
  REVIEW_GATE_PROSE_UNASSESSED,
} from "../src/settings/index.ts";
import type { ReviewFinding, ReviewMode } from "../src/review/reviewSchema.ts";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.ts";

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

describe("severity helpers", () => {
  it("treats P0–P3 as inline-eligible and only P0–P2 as check-failing", () => {
    expect(isInlineSeverity("P0")).toBe(true);
    expect(isInlineSeverity("P1")).toBe(true);
    expect(isInlineSeverity("P2")).toBe(true);
    expect(isInlineSeverity("P3")).toBe(true);
    expect(isCheckFailingSeverity("P0", "P2")).toBe(true);
    expect(isCheckFailingSeverity("P1", "P2")).toBe(true);
    expect(isCheckFailingSeverity("P2", "P2")).toBe(true);
    expect(isCheckFailingSeverity("P3", "P2")).toBe(false);
    expect(isCheckFailingSeverity("P2", "P1")).toBe(false);
    expect(isCheckFailingSeverity("P1", "P1")).toBe(true);
    expect(isCheckFailingSeverity("P3", "P3")).toBe(true);
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: true,
        anchorPath: "src/a.ts",
        judged: true,
      }),
    ).toBe("P2");
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: false,
        anchorPath: "src/a.test.ts",
        judged: true,
      }),
    ).toBe("P2");
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: false,
        anchorPath: "src/a.ts",
        judged: false,
      }),
    ).toBe("P1");
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: true,
        anchorPath: "src/a.ts",
        judged: false,
      }),
    ).toBe("P2");
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: true,
        anchorPath: "src/a.test.ts",
        judged: true,
        coverageGapCeiling: "P0",
      }),
    ).toBe("P0");
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: true,
        anchorPath: "src/foo.test.ts",
        judged: true,
        coverageGapCeiling: "P1",
      }),
    ).toBe("P1");
    expect(
      cappedFindingSeverity({
        severity: "P2",
        testsLens: true,
        anchorPath: "src/a.ts",
        judged: true,
        coverageGapCeiling: "P1",
      }),
    ).toBe("P2");
    expect(
      cappedFindingSeverity({
        severity: "P0",
        testsLens: true,
        anchorPath: "src/a.ts",
        judged: false,
        coverageGapCeiling: "P0",
      }),
    ).toBe("P1");
  });

  it("requires a non-blank fixPrompt for P3 findings", () => {
    const parsed = v.safeParse(
      reviewPayloadSchema,
      makeReviewPayload({
        findings: [
          {
            severity: "P3",
            file: "x.ts",
            startLine: 1,
            endLine: 1,
            title: "Nit",
            detail: "minor",
            fixPrompt: "  ",
          },
        ],
        size: "XS",
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("findings ceiling", () => {
  it("accepts more than eight findings", () => {
    const findings = Array.from({ length: 12 }, (_, i) => makeFinding("P2", `bug-${i}`));
    const parsed = v.safeParse(reviewPayloadSchema, makeReviewPayload({ findings, size: "M" }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.findings).toHaveLength(12);
    }
  });

  it("rejects payloads above the soft findings ceiling", () => {
    const findings = Array.from({ length: 129 }, (_, i) => makeFinding("P2", `bug-${i}`));
    const parsed = v.safeParse(reviewPayloadSchema, makeReviewPayload({ findings, size: "M" }));
    expect(parsed.success).toBe(false);
  });
});

describe("reviewPayloadSchema", () => {
  it("accepts optional suggestedCode and confidence fields", () => {
    const parsed = v.safeParse(
      reviewPayloadSchema,
      makeReviewPayload({
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
      }),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.findings[0]?.suggestedCode).toBe("if (!ok) return;");
      expect(parsed.output.findings[0]?.confidence).toBe(4);
    }
  });

  it("rejects invalid confidence and oversized suggestedCode", () => {
    for (const confidence of [0, 6]) {
      const parsed = v.safeParse(
        reviewPayloadSchema,
        makeReviewPayload({
          findings: [{ ...makeFinding("P1", "bad confidence"), confidence }],
        }),
      );
      expect(parsed.success).toBe(false);
    }

    const oversized = v.safeParse(
      reviewPayloadSchema,
      makeReviewPayload({
        findings: [
          {
            ...makeFinding("P1", "large suggestion"),
            suggestedCode: "x".repeat(REVIEW_FINDING_SUGGESTED_CODE_MAX_CHARS + 1),
          },
        ],
      }),
    );
    expect(oversized.success).toBe(false);
  });
});

describe("reviewFinding leftover violatedRule", () => {
  it("drops leftover violatedRule and still accepts the payload", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
      ...makeReviewPayload(),
      findings: [
        {
          ...makeFinding("P2", "ordinary bug"),
          violatedRule: ".pr-agent/testing.mdc",
        },
      ],
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
      v.safeParse(
        reviewPayloadSchema,
        makeReviewPayload({
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
        }),
      ).success,
    ).toBe(true);

    expect(
      v.safeParse(
        reviewPayloadSchema,
        makeReviewPayload({
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
        }),
      ).success,
    ).toBe(true);

    expect(
      v.safeParse(reviewPayloadSchema, {
        ...makeReviewPayload(),
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
      }).success,
    ).toBe(false);
  });
});

describe("reviewPayload unknown fields", () => {
  it("strips legacy mergeVerdict from parsed payload", () => {
    const parsed = v.safeParse(reviewPayloadSchema, {
      ...makeReviewPayload(),
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
        ...makeReviewPayload(),
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
      expect(formatted.message).toContain("mergeability");
      expect(formatted.message).toContain("blastRadius");
      expect(formatted.paths).toContain("findings");
      expect(formatted.failureKind).toBeTruthy();
    }
  });
});

describe("review gate prose fields", () => {
  it("accepts mergeability and blastRadius within the length caps", () => {
    const payload = makeReviewPayload({
      mergeability: "Two-way: trivial to revert.",
      blastRadius: "Localized: stream error text only.",
    });
    const parsed = v.safeParse(reviewPayloadSchema, payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.output.mergeability).toBe(payload.mergeability);
    expect(parsed.output.blastRadius).toBe(payload.blastRadius);
  });

  it("rejects oversized mergeability and blastRadius", () => {
    expect(
      v.safeParse(
        reviewPayloadSchema,
        makeReviewPayload({ mergeability: "x".repeat(REVIEW_GATE_PROSE_MAX_CHARS + 1) }),
      ).success,
    ).toBe(false);
    expect(
      v.safeParse(
        reviewPayloadSchema,
        makeReviewPayload({ blastRadius: "x".repeat(REVIEW_GATE_PROSE_MAX_CHARS + 1) }),
      ).success,
    ).toBe(false);
  });

  it("degrades missing synthesis gates to unassessed copy", () => {
    expect(reviewPayloadFromFindings([])).toEqual({
      findings: [],
      size: "M",
      followUps: [],
      mergeability: REVIEW_GATE_PROSE_UNASSESSED,
      blastRadius: REVIEW_GATE_PROSE_UNASSESSED,
    });
  });
});

describe("REVIEW_SUMMARY_SENTINEL", () => {
  it("uses one live review mode and the general summary sentinel", () => {
    expectTypeOf<ReviewMode>().toEqualTypeOf<"review">();
    expect(REVIEW_SUMMARY_SENTINEL).toBe("## PR Agent Review");
  });
});
