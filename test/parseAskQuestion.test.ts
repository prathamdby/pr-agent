import { describe, expect, it } from "vitest";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/ask/askSafety.js";
import { ASK_USAGE_HINT } from "../src/settings/index.js";
import {
  ASK_QUESTION_TOO_LONG_HINT,
  parseAskQuestionForReplyTarget,
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

  it("returns too_long when question is too long", () => {
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);
    expect(parseAskQuestionResult(`/ask ${long}`)).toEqual({ kind: "too_long" });
  });

  it("exports too-long hint", () => {
    expect(ASK_QUESTION_TOO_LONG_HINT).toContain(String(MAX_ASK_QUESTION_CHARS));
  });
});

describe("parseAskQuestionForReplyTarget", () => {
  const prConversation = { kind: "prConversation" as const, prNumber: 7 };
  const inlineThread = {
    kind: "inlineReviewThread" as const,
    prNumber: 7,
    inReplyToCommentId: 100,
  };

  it("keeps explicit /ask parse on PR conversation", () => {
    expect(parseAskQuestionForReplyTarget("/ask why?", prConversation)).toEqual({
      kind: "ok",
      question: "why?",
    });
    expect(parseAskQuestionForReplyTarget("why is this P1?", prConversation)).toEqual({
      kind: "not_ask",
    });
  });

  it("coerces raw inline-thread body into an ask question", () => {
    expect(parseAskQuestionForReplyTarget("why is this P1?", inlineThread)).toEqual({
      kind: "ok",
      question: "why is this P1?",
    });
  });

  it("treats empty inline-thread body as missing", () => {
    expect(parseAskQuestionForReplyTarget("   ", inlineThread)).toEqual({ kind: "missing" });
  });

  it("treats too-long inline-thread body as too_long", () => {
    const long = "a".repeat(MAX_ASK_QUESTION_CHARS + 1);
    expect(parseAskQuestionForReplyTarget(long, inlineThread)).toEqual({ kind: "too_long" });
  });

  it("prefers explicit /ask over implicit body coercion", () => {
    expect(parseAskQuestionForReplyTarget("/ask explicit", inlineThread)).toEqual({
      kind: "ok",
      question: "explicit",
    });
    expect(parseAskQuestionResult("/ask")).toEqual({ kind: "missing" });
  });
});
