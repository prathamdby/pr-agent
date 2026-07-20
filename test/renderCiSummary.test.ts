import { describe, expect, it } from "vitest";
import {
  CI_SUMMARY_CELL_END,
  CI_SUMMARY_CELL_START,
  commentBodyHasCiSummaryCell,
  patchCiSummaryCellInCommentBody,
  renderCiSummaryCell,
  shouldRenderCiSummaryRow,
} from "../src/review/ci/renderCiSummary.js";
import type { CiSummary } from "../src/review/ci/ciSummaryTypes.js";

describe("renderCiSummary", () => {
  it("renders a passing headline with markers", () => {
    const summary: CiSummary = {
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    };
    const html = renderCiSummaryCell(summary);
    expect(html).toContain("All CI is passing");
    expect(html.startsWith(CI_SUMMARY_CELL_START)).toBe(true);
    expect(html.endsWith(CI_SUMMARY_CELL_END)).toBe(true);
    expect(shouldRenderCiSummaryRow(summary)).toBe(true);
  });

  it("renders unavailable permission rows and omits none", () => {
    expect(
      shouldRenderCiSummaryRow({
        status: "unavailable",
        headline: "Grant Checks to Read",
        failures: [],
      }),
    ).toBe(true);
    expect(shouldRenderCiSummaryRow({ status: "none", headline: "x", failures: [] })).toBe(false);
    expect(shouldRenderCiSummaryRow(null)).toBe(false);
  });

  it("renders a Checks grant headline for unavailable summaries", () => {
    const html = renderCiSummaryCell({
      status: "unavailable",
      headline:
        "PR Agent can't see check runs on this head. In the GitHub App settings, set Checks to Read, then run /review again.",
      failures: [],
    });
    expect(html).toContain("Checks to Read");
    expect(html).toContain("/review");
  });

  it("renders an Actions permission note under failing digests", () => {
    const html = renderCiSummaryCell({
      status: "failing",
      headline: "❌ CI failing — lint",
      failures: [
        {
          name: "lint",
          reason: "Format issues found",
          fixHint: "Run oxfmt and re-push.",
        },
      ],
      permissionNote:
        "CI failed, but PR Agent can't download the job logs. Set Actions to Read on the GitHub App so the next summary can explain what broke.",
    });
    expect(html).toContain("Format issues found");
    expect(html).toContain("Actions to Read");
    expect(html).toContain("<em>");
  });

  it("renders failure digests with fix hints", () => {
    const html = renderCiSummaryCell({
      status: "failing",
      headline: "❌ CI failing — lint",
      failures: [
        {
          name: "lint",
          reason: "src/foo.ts:12 — Unexpected any",
          fixHint: "Fix the reported lint/format findings locally, then re-push.",
          url: "https://example.com/lint",
        },
      ],
    });
    expect(html).toContain("CI failing");
    expect(html).toContain('href="https://example.com/lint"');
    expect(html).toContain("Unexpected any");
    expect(html).toContain("<em>");
    expect(html).toContain("re-push");
  });

  it("renders failure names with strong tags when url is missing", () => {
    const html = renderCiSummaryCell({
      status: "failing",
      headline: "❌ CI failing — lint",
      failures: [
        {
          name: "lint",
          reason: "src/foo.ts:12 — Unexpected any",
          fixHint: "Fix the reported lint/format findings locally, then re-push.",
        },
      ],
    });
    expect(html).toContain("<strong>lint</strong>");
    expect(html).not.toContain("href=");
  });

  it("patches only the marked CI cell in a summary body", () => {
    const original = [
      "## PR Agent Review",
      "",
      "| Gate | Detail |",
      `| CI | ${renderCiSummaryCell({ status: "pending", headline: "⏳ CI still running", failures: [] })} |`,
      "",
      "<!-- pr-agent:review-meta headSha=abc123 lens=review stale=false -->",
    ].join("\n");
    expect(commentBodyHasCiSummaryCell(original)).toBe(true);
    const patched = patchCiSummaryCellInCommentBody(original, {
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    });
    expect(patched).not.toBeNull();
    expect(patched).toContain("All CI is passing");
    expect(patched).not.toContain("still running");
    expect(patched).toContain("headSha=abc123");
  });
});
