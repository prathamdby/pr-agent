import { describe, expect, it } from "vitest";
import {
  classifyReviewLensFromPointerBody,
  formatPriorInlineFeedbackBlock,
  type PriorInlineFeedbackThread,
} from "../src/agent/reviewPriorFeedback.js";
import {
  REVIEW_POINTER_BODY,
  SECURITY_REVIEW_POINTER_BODY,
} from "../src/settings/index.js";

describe("reviewPriorFeedback", () => {
  it("classifies review lens from pointer body", () => {
    expect(classifyReviewLensFromPointerBody(REVIEW_POINTER_BODY)).toBe("review");
    expect(classifyReviewLensFromPointerBody(SECURITY_REVIEW_POINTER_BODY)).toBe(
      "review-security",
    );
    expect(classifyReviewLensFromPointerBody("unrelated")).toBeNull();
  });

  it("formats trusted context block", () => {
    const threads: PriorInlineFeedbackThread[] = [
      {
        path: "src/a.ts",
        startLine: 4,
        endLine: 4,
        resolved: true,
        botTitleSnippet: "P1 · Missing await",
        humanReplies: ["False positive — already handled upstream"],
        threadUrl: "https://github.com/o/r/pull/1#discussion_r1",
      },
    ];
    const block = formatPriorInlineFeedbackBlock(threads);
    expect(block).toContain("Prior inline review feedback");
    expect(block).toContain("False positive");
    expect(block).toContain("discussion_r1");
  });
});
