import { describe, expect, it } from "vitest";
import { fixDoubleEscapedString } from "../src/agent/tools/fixDoubleEscapedString.js";
import { coerceReviewPayloadInput } from "../src/review/reviewSchema.js";

describe("fixDoubleEscapedString", () => {
  it("unwraps a single JSON-level newline escape", () => {
    // Actual characters: line one + \ + n + line two
    const input = String.raw`line one\nline two`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: "line one\nline two",
      fixed: true,
    });
  });

  it("unwraps tab and carriage-return escapes together", () => {
    // Actual characters: a + \ + t + b + \ + r + c
    const input = String.raw`a\tb\rc`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: "a\tb\rc",
      fixed: true,
    });
  });

  it("parses quote-wrapped JSON string literals", () => {
    // Actual characters: " + hello + \ + n + world + "
    const input = String.raw`"hello\nworld"`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: "hello\nworld",
      fixed: true,
    });
  });

  it("preserves doubled backslashes before escape letters", () => {
    // Actual characters: path + \ + \ + n + file
    const input = String.raw`path\\nfile`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves Windows drive-letter path fragments", () => {
    // Actual characters: C : \ n e w \ t m p \ f i l e . t x t
    const input = String.raw`C:\new\tmp\file.txt`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves UNC path prefixes", () => {
    // Actual characters: \ + \ + server + \ + n a m e + \ + share
    const input = String.raw`\\server\name\share`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves regex literals with escape candidates", () => {
    // Actual characters: / + \ + n + + + /
    const input = String.raw`/\n+/`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves regex class escapes mixed with newline candidates", () => {
    // Actual characters: f o o + \ + d + + + \ + n + b a r
    const input = String.raw`foo\d+\nbar`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("fails closed on quote-only or backslash-only decode changes", () => {
    // Actual characters: s a y + \ + " + h i + \ + "
    const quotesOnly = String.raw`say \"hi\"`;
    expect(fixDoubleEscapedString(quotesOnly)).toEqual({
      text: quotesOnly,
      fixed: false,
    });

    // Actual characters: a + \ + \ + b — doubled backslash, no control materialization
    const backslashesOnly = String.raw`a\\b`;
    expect(fixDoubleEscapedString(backslashesOnly)).toEqual({
      text: backslashesOnly,
      fixed: false,
    });
  });

  it("fails closed on malformed JSON string bodies", () => {
    // Actual characters: h e l l o + \ + n + " + w o r l d (unescaped quote)
    const input = String.raw`hello\n"world`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("skips strings without JSON escape candidates", () => {
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
          detail: String.raw`first\nsecond`,
          fixPrompt: "Fix it",
        },
      ],
      size: "S",
      relevantTests: "no",
      securityConcerns: null,
      followUps: [],
    });
    const finding = (value as { findings: Array<{ detail: string }> }).findings[0];
    expect(finding?.detail).toBe("first\nsecond");
    expect(coercions).toContain("finding_detail_double_escape");
  });
});
