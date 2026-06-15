import { describe, expect, it } from "vitest";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/askSafety.js";
import { ASK_USAGE_HINT } from "../src/settings.js";
import {
  ASK_QUESTION_TOO_LONG_HINT,
  parseAskQuestionResult,
} from "../src/commands/parseAskQuestion.js";

describe("parseAskQuestionResult", () => {
  it("extracts unquoted question from first line", () => {
    expect(parseAskQuestionResult("/ask what is this for?")).toEqual({
      kind: "ok",
      question: "what is this for?",
    });
  });

  it("extracts double-quoted question", () => {
    expect(parseAskQuestionResult('/ask "what is useHydrationSafeDistance?"')).toEqual({
      kind: "ok",
      question: "what is useHydrationSafeDistance?",
    });
  });

  it("extracts single-quoted question", () => {
    expect(parseAskQuestionResult("/ask 'why this change?'")).toEqual({
      kind: "ok",
      question: "why this change?",
    });
  });

  it("returns missing for bare /ask", () => {
    expect(parseAskQuestionResult("/ask")).toEqual({ kind: "missing" });
    expect(parseAskQuestionResult("/ask   ")).toEqual({ kind: "missing" });
  });

  it("returns not_ask when not an ask command", () => {
    expect(parseAskQuestionResult("/review")).toEqual({ kind: "not_ask" });
    expect(parseAskQuestionResult("hello")).toEqual({ kind: "not_ask" });
  });

  it("uses first non-empty line only", () => {
    expect(parseAskQuestionResult(" \n/ask what is this?")).toEqual({
      kind: "ok",
      question: "what is this?",
    });
    expect(parseAskQuestionResult(" \r\n/ask what is this?\n/ask ignored")).toEqual({
      kind: "ok",
      question: "what is this?",
    });
    expect(parseAskQuestionResult("hello\n/ask ignored")).toEqual({ kind: "not_ask" });
  });

  it("is case-sensitive on /ask token", () => {
    expect(parseAskQuestionResult("/Ask what?")).toEqual({ kind: "not_ask" });
  });

  it("exports usage hint", () => {
    expect(ASK_USAGE_HINT).toContain("/ask");
  });

  it("returns too_long when question exceeds limit", () => {
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);
    expect(parseAskQuestionResult(`/ask ${long}`)).toEqual({ kind: "too_long" });
  });

  it("exports too-long hint", () => {
    expect(ASK_QUESTION_TOO_LONG_HINT).toContain(String(MAX_ASK_QUESTION_CHARS));
  });
});
