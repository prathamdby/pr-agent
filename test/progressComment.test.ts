import { describe, expect, it } from "vitest";
import {
  initialProgressTickState,
  parseProgressRevision,
  parseProgressRevisionState,
  renderReviewFailureNotice,
  renderReviewProgressComment,
} from "../src/review/run/progressComment.js";
import {
  REVIEW_PROGRESS_NOTE,
  REVIEW_PROGRESS_SOURCE_SLASH,
  REVIEW_SUMMARY_SENTINEL,
} from "../src/settings/index.js";
import {
  STATUS_FAILED,
  STATUS_NO_FINDINGS,
  STATUS_RUNNING,
  STATUS_WAITING,
} from "../src/github/statusCopy.js";

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

  it("renders progress with NOTE alert, metadata table, and full roster", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "auto",
      tickState: initialProgressTickState(),
    });
    expect(body).toContain("[!NOTE]");
    expect(body).toContain(REVIEW_PROGRESS_NOTE);
    expect(body).toContain("<strong>Head</strong>");
    expect(body).toContain("<code>abc123</code>");
    expect(body).toContain("Pull request update");
    expect(body).toContain("<strong>Recon</strong>");
    expect(body).toContain(STATUS_RUNNING);
    expect(body).toContain(STATUS_WAITING);
    expect(body).toContain("<strong>Correctness</strong>");
    expect(body).not.toContain("| | |");
    expect(body).toContain("<table>");
    expect(body).not.toContain("<strong>CI</strong>");
    expect(body).toContain("<!-- pr-agent:review-meta headSha=invalid lens=review stale=false -->");
    expect(parseProgressRevision(body)).toBe(0);
  });

  it("capitalizes slash source labels", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "slash",
      tickState: initialProgressTickState(),
    });
    expect(body).toContain(REVIEW_PROGRESS_SOURCE_SLASH);
    expect(body).not.toContain("slash command");
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
      tickState: initialProgressTickState(),
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
        recon: "done",
        specialists: {
          correctness: { phase: "done", findingsAccepted: 0 },
          security: { phase: "done", findingsAccepted: 2 },
          quality: { phase: "running" },
          tests: { phase: "no_findings" },
        },
      },
    });

    expect(body.indexOf("<strong>Source</strong>")).toBeLessThan(
      body.indexOf("<strong>Recon</strong>"),
    );
    expect(body.indexOf("<strong>Recon</strong>")).toBeLessThan(
      body.indexOf("<strong>Correctness</strong>"),
    );
    expect(body).toContain(STATUS_NO_FINDINGS);
    expect(body).toContain("✅ 2 findings");
    expect(body).toContain(STATUS_RUNNING);
    expect(body).not.toContain("0 threads");
    expect(body).not.toContain("no findings");
    expect(parseProgressRevision(body)).toBe(3);
  });

  it("renders failed specialist coverage explicitly", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "slash",
      tickState: {
        kind: "specialists",
        recon: "done",
        specialists: {
          correctness: { phase: "running" },
          security: { phase: "running" },
          quality: { phase: "failed" },
          tests: { phase: "running" },
        },
      },
    });

    expect(body).toContain(STATUS_FAILED);
    expect(body).not.toContain("coverage partial");
  });

  it("renders one published finding with singular copy", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "auto",
      tickState: {
        kind: "specialists",
        recon: "done",
        specialists: {
          correctness: { phase: "done", findingsAccepted: 1 },
          security: { phase: "running" },
          quality: { phase: "running" },
          tests: { phase: "running" },
        },
      },
    });

    expect(body).toContain("✅ 1 finding");
    expect(body).not.toContain("✅ 1 findings");
  });

  it("counts accepted findings including summary-only on the specialist row", () => {
    const body = renderReviewProgressComment({
      mode: "review",
      headSha: "abc123",
      source: "auto",
      tickState: {
        kind: "specialists",
        recon: "done",
        specialists: {
          correctness: { phase: "done", findingsAccepted: 3 },
          security: { phase: "no_findings" },
          quality: { phase: "failed" },
          tests: { phase: "done", findingsAccepted: 0 },
        },
      },
    });

    expect(body).toContain("✅ 3 findings");
    expect(body).toContain(STATUS_NO_FINDINGS);
    expect(body).toContain(STATUS_FAILED);
    expect(body).not.toContain("0 threads");
  });

  it.each([
    ["slash", "superseded", "Superseded. Rescheduled for new head.", false],
    ["auto", "superseded", "Superseded by a newer pull request update.", false],
    ["slash", "stale_head", "Superseded. Rescheduled for new head.", true],
    ["auto", "stale_head", "Superseded. Rescheduled for new head.", true],
  ] as const)(
    "renders source-aware %s terminal copy with exact stale metadata",
    (source, reason, expected, stale) => {
      const body = renderReviewProgressComment({
        mode: "review",
        headSha: "abc123",
        source,
        progressRevision: 6,
        ciSummary: {
          status: "pending",
          headline: "⏳ CI is still running",
          failures: [],
        },
        tickState: {
          kind: "terminal",
          reason,
          recon: "done",
          specialists: {
            correctness: { phase: "done", findingsAccepted: 1 },
            security: { phase: "running" },
            quality: { phase: "waiting" },
            tests: { phase: "waiting" },
          },
        },
      });

      expect(body.startsWith(REVIEW_SUMMARY_SENTINEL)).toBe(true);
      expect(body).toContain(expected);
      expect(body).toContain("<strong>CI</strong>");
      expect(body).toContain("CI is still running");
      expect(body).toContain("<strong>Recon</strong>");
      expect(body).toContain("<strong>Correctness</strong>");
      expect(body).toContain("<strong>Security</strong>");
      expect(body).toContain("<strong>Quality</strong>");
      expect(body).toContain("<strong>Tests</strong>");
      expect(body).toContain("✅ 1 finding");
      expect(body).toContain(STATUS_RUNNING);
      expect(body).toContain(STATUS_WAITING);
      expect(body.indexOf("<strong>Source</strong>")).toBeLessThan(
        body.indexOf("<strong>CI</strong>"),
      );
      expect(body.indexOf("<strong>CI</strong>")).toBeLessThan(
        body.indexOf("<strong>Recon</strong>"),
      );
      expect(body).toContain(
        `<!-- pr-agent:review-meta headSha=invalid lens=review stale=${String(stale)} -->`,
      );
      expect(parseProgressRevision(body)).toBe(6);
    },
  );

  it("returns null for a malformed encoded progress work item id", () => {
    expect(
      parseProgressRevisionState("<!-- pr-agent:progress-revision workItemId=%E0%A4%A value=1 -->"),
    ).toBeNull();
  });
});
