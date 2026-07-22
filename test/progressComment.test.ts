import { describe, expect, it } from "vitest";
import {
  parseProgressRevision,
  parseProgressRevisionState,
  renderReviewFailureNotice,
  renderReviewProgressComment,
} from "../src/review/run/progressComment.js";
import { REVIEW_PROGRESS_NOTE, REVIEW_SUMMARY_SENTINEL } from "../src/settings/index.js";

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
    expect(body).not.toContain("<strong>CI</strong>");
    expect(body).toContain("<!-- pr-agent:review-meta headSha=invalid lens=review stale=false -->");
    expect(parseProgressRevision(body)).toBe(0);
  });

  it("includes a CI row when a renderable CI summary is provided", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
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

  it("renders every specialist phase below the existing progress rows", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "auto",
      progressRevision: 3,
      tickState: {
        kind: "specialists",
        specialists: {
          correctness: { phase: "done", threadsPublished: 0 },
          security: { phase: "done", threadsPublished: 2 },
          quality: { phase: "running" },
          tests: { phase: "no_findings" },
        },
      },
    });

    expect(body.indexOf("<strong>Source</strong>")).toBeLessThan(
      body.indexOf("<strong>Correctness</strong>"),
    );
    expect(body).toContain("✅ 0 threads");
    expect(body).toContain("✅ 2 threads");
    expect(body).toContain("⏳ running");
    expect(body).toContain("⚪ no findings");
    expect(parseProgressRevision(body)).toBe(3);
  });

  it("renders failed specialist coverage explicitly", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "slash",
      tickState: {
        kind: "specialists",
        specialists: {
          correctness: { phase: "running" },
          security: { phase: "running" },
          quality: { phase: "failed" },
          tests: { phase: "running" },
        },
      },
    });

    expect(body).toContain("⚠️ failed (coverage partial)");
  });

  it("renders one published thread with singular copy", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "auto",
      tickState: {
        kind: "specialists",
        specialists: {
          correctness: { phase: "done", threadsPublished: 1 },
          security: { phase: "running" },
          quality: { phase: "running" },
          tests: { phase: "running" },
        },
      },
    });

    expect(body).toContain("✅ 1 thread");
    expect(body).not.toContain("✅ 1 threads");
  });

  it.each([
    ["slash", "superseded", "Superseded. Rescheduled for new head.", false],
    ["auto", "superseded", "Superseded by a newer pull request update.", false],
    ["slash", "stale_head", "Superseded. Rescheduled for new head.", true],
  ] as const)(
    "renders source-aware %s terminal copy with exact stale metadata",
    (source, reason, expected, stale) => {
      const body = renderReviewProgressComment({
        mode: "review",
        headSha: "abc123",
        source,
        progressRevision: 5,
        tickState: { kind: "terminal", reason },
      });

      expect(body.startsWith(REVIEW_SUMMARY_SENTINEL)).toBe(true);
      expect(body).toContain(expected);
      expect(body).toContain(
        `<!-- pr-agent:review-meta headSha=invalid lens=review stale=${String(stale)} -->`,
      );
      expect(parseProgressRevision(body)).toBe(5);
    },
  );

  it("returns null for a malformed encoded progress work item id", () => {
    expect(
      parseProgressRevisionState("<!-- pr-agent:progress-revision workItemId=%E0%A4%A value=1 -->"),
    ).toBeNull();
  });
});
