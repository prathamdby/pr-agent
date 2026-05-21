import { describe, expect, it } from "vitest";
import {
  renderReviewFailureNotice,
  renderStructuredPublishFallback,
} from "../src/agentWork/progressComment.js";

describe("progressComment fallback wording", () => {
  it("uses neutral failure notice without attempt counts or server logs", () => {
    const body = renderReviewFailureNotice({ mode: "review", retryCommand: "/review" });
    expect(body).toContain("could not complete");
    expect(body).toContain("/review");
    expect(body).not.toMatch(/structured publish/i);
    expect(body).not.toMatch(/server logs/i);
    expect(body).not.toMatch(/\d+\/\d+/);
  });

  it("keeps security retry command", () => {
    const body = renderStructuredPublishFallback({ mode: "review-security" });
    expect(body).toContain("/review-security");
    expect(body).not.toMatch(/structured publish/i);
  });
});
