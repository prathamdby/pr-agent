import { describe, expect, it } from "vitest";
import { formatAskReply, sanitizeAskAnswerText } from "../src/agent/ask/formatAskReply.js";

describe("formatAskReply", () => {
  it("returns plain answer for inline review threads", () => {
    const body = formatAskReply({
      question: "what is this?",
      answer: "It is a hydration-safe hook.",
      replyTarget: {
        kind: "inlineReviewThread",
        prNumber: 1,
        inReplyToCommentId: 99,
      },
    });
    expect(body).toBe("It is a hydration-safe hook.");
    expect(body).not.toContain("**Question:**");
  });

  it("wraps question and answer on PR conversation", () => {
    const body = formatAskReply({
      question: "what is this?",
      answer: "It is a hydration-safe hook.",
      replyTarget: { kind: "prConversation", prNumber: 1 },
    });
    expect(body).toContain("**Question:** what is this?");
    expect(body).toContain("**Answer:**");
    expect(body).toContain("It is a hydration-safe hook.");
  });

  it("redacts secret-shaped strings in the echoed PR conversation question", () => {
    const body = formatAskReply({
      question: "why does ghp_1234567890123456789012345678901234 fail auth?",
      answer: "Check the installation token.",
      replyTarget: { kind: "prConversation", prNumber: 1 },
    });
    expect(body).toContain("**Question:**");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("ghp_1234567890123456789012345678901234");
  });

  it("keeps inline replies answer-only even when the question has secrets", () => {
    const body = formatAskReply({
      question: "postgres://user:pass@host/db why?",
      answer: "Connection string should not be in the PR.",
      replyTarget: {
        kind: "inlineReviewThread",
        prNumber: 1,
        inReplyToCommentId: 99,
      },
    });
    expect(body).toBe("Connection string should not be in the PR.");
    expect(body).not.toContain("postgres://");
    expect(body).not.toContain("**Question:**");
  });

  it.each([
    ["postgres connection", "why is postgres://alice:s3cret@db.example/app failing?"],
    ["openai-shaped key", "does sk-abcdefghijklmnopqrstuvwxyz123456 work here?"],
    ["aws access key id", "is AKIAIOSFODNN7EXAMPLE valid for this install?"],
  ] as const)("redacts %s patterns in PR conversation questions", (_label, question) => {
    const body = formatAskReply({
      question,
      answer: "Use a short-lived installation token instead.",
      replyTarget: { kind: "prConversation", prNumber: 1 },
    });
    expect(body).toContain("[redacted]");
    expect(body).not.toMatch(/postgres:\/\/|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{16}/);
  });
});

describe("sanitizeAskAnswerText", () => {
  it("prefixes lines starting with slash", () => {
    expect(sanitizeAskAnswerText("/review again")).toBe(" /review again");
  });

  it("escapes newline-slash sequences", () => {
    expect(sanitizeAskAnswerText("line\n/help")).toBe("line\n /help");
  });

  it("redacts ghp_ tokens in answers", () => {
    expect(sanitizeAskAnswerText("key is ghp_1234567890123456789012345678901234")).toContain(
      "[redacted]",
    );
  });
});
