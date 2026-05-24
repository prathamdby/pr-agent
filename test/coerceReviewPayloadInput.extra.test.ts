import { describe, expect, it } from "vitest";
import { coerceReviewPayloadInput, reviewPayloadSchema } from "../src/agent/reviewSchema.js";

describe("coerceReviewPayloadInput extra rescue rules", () => {
  it("maps line to startLine/endLine", () => {
    const { value, coercions } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [
        {
          severity: "P1",
          file: "a.ts",
          line: 42,
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coercions).toContain("finding_line_to_start_end");
    const parsed = reviewPayloadSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings[0]?.startLine).toBe(42);
      expect(parsed.data.findings[0]?.endLine).toBe(42);
    }
  });

  it("does not coerce decimal line numbers", () => {
    const { value, coercions } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [
        {
          severity: "P1",
          file: "a.ts",
          line: "42.9",
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coercions).not.toContain("finding_line_to_start_end");
    const parsed = reviewPayloadSchema.safeParse(value);
    expect(parsed.success).toBe(false);
  });

  it("maps lines array to startLine/endLine", () => {
    const { coercions } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [
        {
          severity: "P1",
          file: "a.ts",
          lines: [10, 12],
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coercions).toContain("finding_lines_array_to_start_end");
  });

  it("unwraps payload envelope keys", () => {
    const { coercions } = coerceReviewPayloadInput({
      payload: {
        prCharacter: "x",
        findings: [],
        estimatedEffort: 1,
        relevantTests: "no",
        securityConcerns: null,
        followUps: [],
      },
    });
    expect(coercions).toContain("unwrap_payload");
  });

  it("coerces single-object findings to array", () => {
    const { coercions } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: {
        severity: "P2",
        file: "a.ts",
        startLine: 1,
        endLine: 1,
        title: "t",
        detail: "d",
        fixPrompt: "fix",
      },
      estimatedEffort: 1,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coercions).toContain("findings_object_to_array");
  });

  it("rescues severity aliases like P1 (High) and integer 2", () => {
    const { value, coercions } = coerceReviewPayloadInput({
      prCharacter: "x",
      findings: [
        {
          severity: "P1 (High)",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          detail: "d",
          fixPrompt: "fix",
        },
        {
          severity: 2,
          file: "b.ts",
          startLine: 1,
          endLine: 1,
          title: "t2",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 1,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(coercions.filter((c) => c === "finding_severity_alias")).toHaveLength(2);
    const parsed = reviewPayloadSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings[0]?.severity).toBe("P1");
      expect(parsed.data.findings[1]?.severity).toBe("P1");
    }
  });

  it("strips fences only when wrapping entire trimmed value", () => {
    const wrapped = coerceReviewPayloadInput({
      prCharacter: "```\nSummary text\n```",
      findings: [
        {
          severity: "P2",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          detail: "Use `foo` inline and ```not stripped``` mid-string",
          fixPrompt: "fix",
        },
      ],
      estimatedEffort: 1,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    expect(wrapped.coercions).toContain("prCharacter_fence_strip");
    expect(
      (wrapped.value as { findings: Array<{ detail: string }> }).findings[0]?.detail,
    ).toContain("```not stripped```");
    expect(wrapped.coercions).not.toContain("finding_detail_fence_strip");
  });
});
