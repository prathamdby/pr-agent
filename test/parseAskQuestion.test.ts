import { describe, expect, it } from "vitest";
import { MAX_ASK_QUESTION_CHARS } from "../src/agent/ask/askSafety.js";
import { ASK_USAGE_HINT } from "../src/settings/index.js";
import {
  ASK_QUESTION_TOO_LONG_HINT,
  askQuestionParseFailure,
  parseAskQuestion,
  parseAskQuestionForReplyTarget,
  parseAskQuestionResult,
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
    expect(parseAskQuestion(" \r\n/ask what is this?\n/ask ignored")).toBe("what is this?");
    expect(parseAskQuestion("hello\n/ask ignored")).toBe(null);
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
