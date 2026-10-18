import { describe, expect, it } from "vitest";
import { fixDoubleEscapedString } from "../src/agent/tools/fixDoubleEscapedString.ts";

describe("fixDoubleEscapedString", () => {
  it("unwraps a single JSON-level newline escape", () => {
    const input = String.raw`line one\nline two`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: "line one\nline two",
      fixed: true,
    });
  });

  it("unwraps tab and carriage-return escapes together", () => {
    const input = String.raw`a\tb\rc`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: "a\tb\rc",
      fixed: true,
    });
  });

  it("parses quote-wrapped JSON string literals", () => {
    const input = String.raw`"hello\nworld"`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: "hello\nworld",
      fixed: true,
    });
  });

  it("preserves doubled backslashes before escape letters", () => {
    const input = String.raw`path\\nfile`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves Windows drive-letter path fragments", () => {
    const input = String.raw`C:\new\tmp\file.txt`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves UNC path prefixes", () => {
    const input = String.raw`\\server\name\share`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves regex literals with escape candidates", () => {
    const input = String.raw`/\n+/`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("preserves regex class escapes mixed with newline candidates", () => {
    const input = String.raw`foo\d+\nbar`;
    expect(fixDoubleEscapedString(input)).toEqual({
      text: input,
      fixed: false,
    });
  });

  it("fails closed on quote-only or backslash-only decode changes", () => {
    const quotesOnly = String.raw`say \"hi\"`;
    expect(fixDoubleEscapedString(quotesOnly)).toEqual({
      text: quotesOnly,
      fixed: false,
    });

    const backslashesOnly = String.raw`a\\b`;
    expect(fixDoubleEscapedString(backslashesOnly)).toEqual({
      text: backslashesOnly,
      fixed: false,
    });
  });

  it("fails closed on malformed JSON string bodies", () => {
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
