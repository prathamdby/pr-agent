import { describe, expect, it } from "vitest";
import {
  renderReviewFailureNotice,
  renderReviewProgressComment,
} from "../src/review/run/progressComment.js";
import { parseReviewMetaFromCommentBody } from "../src/review/ci/reviewMetaParse.js";
import { REVIEW_PROGRESS_NOTE, REVIEW_SUMMARY_SENTINEL } from "../src/settings/index.js";

const HEAD_SHA = "abc123abc123abc123abc123abc123abc123abc1";

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

  it("renders progress with NOTE alert and metadata table", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: HEAD_SHA,
      source: "auto",
    });
    expect(body).toContain("[!NOTE]");
    expect(body).toContain(REVIEW_PROGRESS_NOTE);
    expect(body).toContain("<strong>Head</strong>");
    expect(body).toContain(`<code>${HEAD_SHA}</code>`);
    expect(body).toContain("Pull request update");
    expect(body).not.toContain("| | |");
    expect(body).toContain("<table>");
    expect(body).not.toContain("<strong>CI</strong>");
    expect(body.startsWith(REVIEW_SUMMARY_SENTINEL)).toBe(true);
    expect(parseReviewMetaFromCommentBody(body)).toEqual({
      headSha: HEAD_SHA,
      lens: "review",
      stale: false,
    });
  });

  it("includes a CI row when a renderable CI summary is provided", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: HEAD_SHA,
      source: "slash",
      ciSummary: {
        status: "passing",
        headline: "✅ All CI is passing",
        failures: [],
      },
    });
    expect(body).toContain("<strong>CI</strong>");
    expect(body).toContain("All CI is passing");
  });

  it("renders specialist tick phases under the head table", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: HEAD_SHA,
      source: "slash",
      specialistTicks: {
        correctness: { phase: "done", threadsPublished: 2 },
        security: { phase: "running" },
        quality: { phase: "no_findings" },
        tests: { phase: "failed" },
      },
    });
    expect(body).toContain("<strong>Correctness</strong>");
    expect(body).toContain("✅ 2 threads");
    expect(body).toContain("<strong>Security</strong>");
    expect(body).toContain("⏳ running");
    expect(body).toContain("<strong>Quality</strong>");
    expect(body).toContain("⚪ no findings");
    expect(body).toContain("<strong>Tests</strong>");
    expect(body).toContain("⚠️ failed (coverage partial)");
    expect(body.startsWith(REVIEW_SUMMARY_SENTINEL)).toBe(true);
    expect(parseReviewMetaFromCommentBody(body)?.headSha).toBe(HEAD_SHA);
  });

  it("renders a done tick with zero threads", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: HEAD_SHA,
      source: "auto",
      specialistTicks: {
        correctness: { phase: "done", threadsPublished: 0 },
        security: { phase: "running" },
        quality: { phase: "running" },
        tests: { phase: "running" },
      },
    });
    expect(body).toContain("✅ 0 threads");
  });

  it("renders run-level superseded-rescheduled terminal state", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: HEAD_SHA,
      source: "slash",
      runPhase: "superseded_rescheduled",
      specialistTicks: {
        correctness: { phase: "running" },
        security: { phase: "done", threadsPublished: 1 },
        quality: { phase: "no_findings" },
        tests: { phase: "failed" },
      },
    });
    expect(body).toContain("superseded — rescheduled for new head");
    expect(body.startsWith(REVIEW_SUMMARY_SENTINEL)).toBe(true);
    expect(parseReviewMetaFromCommentBody(body)?.headSha).toBe(HEAD_SHA);
  });
});
