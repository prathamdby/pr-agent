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

  it("omits unavailable and none rows", () => {
    expect(shouldRenderCiSummaryRow({ status: "unavailable", headline: "x", failures: [] })).toBe(
      false,
    );
    expect(shouldRenderCiSummaryRow({ status: "none", headline: "x", failures: [] })).toBe(false);
    expect(shouldRenderCiSummaryRow(null)).toBe(false);
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
