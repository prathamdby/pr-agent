import { describe, expect, it } from "vitest";
import {
  renderReviewFailureNotice,
  renderReviewProgressComment,
} from "../src/review/progressComment.js";
import { REVIEW_PROGRESS_NOTE } from "../src/settings.js";

describe("progressComment fallback wording", () => {
  it("uses neutral failure notice without attempt counts or server logs", () => {
    const body = renderReviewFailureNotice({
      mode: "review",
      retryCommand: "/review",
    });
    expect(body).toContain("[!CAUTION]");
    expect(body).toContain("Review did not finish");
    expect(body).toContain("/review");
    expect(body).not.toMatch(/structured publish/i);
    expect(body).not.toMatch(/server logs/i);
    expect(body).not.toMatch(/\d+\/\d+/);
  });

  it("keeps security retry command", () => {
    const body = renderReviewFailureNotice({
      mode: "review-security",
      retryCommand: "/review-security",
    });
    expect(body).toContain("/review-security");
    expect(body).toContain("[!CAUTION]");
    expect(body).not.toMatch(/structured publish/i);
  });

  it("renders progress with NOTE alert and metadata table", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "auto",
    });
    expect(body).toContain("[!NOTE]");
    expect(body).toContain(REVIEW_PROGRESS_NOTE);
    expect(body).toContain("<strong>Head</strong>");
    expect(body).toContain("<code>abc123</code>");
    expect(body).toContain("Pull request update");
    expect(body).not.toContain("| | |");
    expect(body).toContain("<table>");
  });
});
