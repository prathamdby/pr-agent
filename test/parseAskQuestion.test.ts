import { describe, expect, it } from "vitest";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/askSafety.js";
import { ASK_USAGE_HINT } from "../src/settings/index.js";
import {
  ASK_QUESTION_TOO_LONG_HINT,
  askQuestionParseFailure,
  parseAskQuestion,
} from "../src/commands/parseAskQuestion.js";

describe("parseAskQuestion", () => {
  it("extracts unquoted question from first line", () => {
    expect(parseAskQuestion("/ask what is this for?")).toBe("what is this for?");
  });

  it("extracts double-quoted question", () => {
    expect(parseAskQuestion('/ask "what is useHydrationSafeDistance?"')).toBe(
      "what is useHydrationSafeDistance?",
    );
  });

  it("extracts single-quoted question", () => {
    expect(parseAskQuestion("/ask 'why this change?'")).toBe("why this change?");
  });

  it("returns null for bare /ask", () => {
    expect(parseAskQuestion("/ask")).toBe(null);
    expect(parseAskQuestion("/ask   ")).toBe(null);
  });

  it("returns null when not an ask command", () => {
    expect(parseAskQuestion("/review")).toBe(null);
    expect(parseAskQuestion("hello")).toBe(null);
  });

  it("uses first non-empty line only", () => {
    expect(parseAskQuestion(" \n/ask what is this?")).toBe("what is this?");
  });

  it("is case-sensitive on /ask token", () => {
    expect(parseAskQuestion("/Ask what?")).toBe(null);
  });

  it("exports usage hint", () => {
    expect(ASK_USAGE_HINT).toContain("/ask");
  });

  it("returns null when question is too long", () => {
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);
    expect(parseAskQuestion(`/ask ${long}`)).toBe(null);
    expect(askQuestionParseFailure(`/ask ${long}`)).toBe("too_long");
  });

  it("exports too-long hint", () => {
    expect(ASK_QUESTION_TOO_LONG_HINT).toContain(String(MAX_ASK_QUESTION_CHARS));
  });
});
