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

  it("does not treat raw inline-thread body without mention as ask", () => {
    expect(parseAskQuestionForReplyTarget("why is this P1?", inlineThread)).toEqual({
      kind: "not_ask",
    });
  });

  it("parses @mention ask with full bot login", () => {
    expect(
      parseAskQuestionForReplyTarget("@pr-agent[bot] why?", inlineThread, "pr-agent[bot]"),
    ).toEqual({
      kind: "ok",
      question: "why?",
    });
  });

  it("parses @mention with slug login", () => {
    expect(
      parseAskQuestionForReplyTarget("@pr-agent explain", inlineThread, "pr-agent[bot]"),
    ).toEqual({
      kind: "ok",
      question: "explain",
    });
  });

  it("returns not_ask when bot mention is absent", () => {
    expect(parseAskQuestionForReplyTarget("explain", inlineThread, "pr-agent[bot]")).toEqual({
      kind: "not_ask",
    });
  });

  it("prefers explicit /ask over @mention", () => {
    expect(parseAskQuestionForReplyTarget("/ask explicit", inlineThread)).toEqual({
      kind: "ok",
      question: "explicit",
    });
    expect(parseAskQuestionResult("/ask")).toEqual({ kind: "missing" });
  });
});
