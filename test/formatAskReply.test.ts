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
