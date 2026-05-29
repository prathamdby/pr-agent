import { describe, expect, it } from "vitest";
import {
  coerceReviewPayloadInput,
  formatReviewValidationError,
  reviewEventForFindings,
  reviewPayloadSchema,
  reviewSummarySentinelForMode,
  reviewRetrySlashCommandForMode,
  selectInlineFindings,
} from "../src/agent/reviewSchema.js";
import type { ReviewFinding } from "../src/agent/reviewSchema.js";

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
  const f = (severity: ReviewFinding["severity"], title: string): ReviewFinding => ({
    severity,
    file: "x.ts",
    startLine: 1,
    endLine: 1,
    title,
    detail: "d",
    fixPrompt: severity === "P3" ? undefined : "fix",
  });

  it("returns all P0-P2 inline findings sorted by severity", () => {
    const selected = selectInlineFindings([f("P2", "p2"), f("P0", "p0"), f("P1", "p1")]);
    expect(selected.map((x) => x.title)).toEqual(["p0", "p1", "p2"]);
  });

  it("excludes P3", () => {
    const selected = selectInlineFindings([f("P3", "p3"), f("P1", "p1")]);
    expect(selected.map((x) => x.title)).toEqual(["p1"]);
  });

  it("accepts more than eight findings", () => {
    const findings = Array.from({ length: 12 }, (_, i) => f("P2", `bug-${i}`));
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
    const findings = Array.from({ length: 129 }, (_, i) => f("P2", `bug-${i}`));
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
  it("returns the quality sentinel for review-quality", () => {
    expect(reviewSummarySentinelForMode("review-quality")).toBe("## PR Agent Quality Review");
  });
});

describe("reviewRetrySlashCommandForMode", () => {
  it("returns /review-quality for review-quality mode", () => {
    expect(reviewRetrySlashCommandForMode("review-quality")).toBe("/review-quality");
  });
});
