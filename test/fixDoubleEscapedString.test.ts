import { describe, expect, it } from "vitest";
import { fixDoubleEscapedString } from "../src/agent/fixDoubleEscapedString.js";
import { coerceReviewPayloadInput } from "../src/agent/reviewSchema.js";

describe("fixDoubleEscapedString", () => {
  it("unwraps literal escape sequences", () => {
    expect(fixDoubleEscapedString("line one\\nline two")).toEqual({
      text: "line one\nline two",
      fixed: true,
    });
  });

  it("parses JSON-encoded string literals", () => {
    expect(fixDoubleEscapedString('"hello\\nworld"')).toEqual({
      text: "hello\nworld",
      fixed: true,
    });
  });

  it("unescapes backslashes before other sequences", () => {
    expect(fixDoubleEscapedString("path\\\\nfile")).toEqual({
      text: "path\nfile",
      fixed: true,
    });
  });

  it("skips strings without double-escape markers", () => {
    expect(fixDoubleEscapedString("plain text")).toEqual({
      text: "plain text",
      fixed: false,
    });
  });
});

describe("coerceReviewPayloadInput double escape", () => {
  it("coerces double-escaped finding detail", () => {
    const { value, coercions } = coerceReviewPayloadInput({
      prCharacter: "Summary",
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug",
          detail: "first\\nsecond",
          fixPrompt: "Fix it",
        },
      ],
      estimatedEffort: 2,
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    const finding = (value as { findings: Array<{ detail: string }> }).findings[0];
    expect(finding?.detail).toBe("first\nsecond");
    expect(coercions).toContain("finding_detail_double_escape");
  });
});
