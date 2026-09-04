import { describe, expect, it } from "vitest";
import {
  CI_SUMMARY_CELL_END,
  CI_SUMMARY_CELL_START,
  commentBodyHasCiSummaryCell,
  formatCiSummaryPlainText,
  patchCiSummaryCellInCommentBody,
  preserveCiSummaryRowInCommentBody,
  renderCiSummaryCell,
  shouldRenderCiSummaryRow,
} from "../src/review/ci/renderCiSummary.js";
import type { CiSummary } from "../src/review/ci/ciSummaryTypes.js";
import { renderVerificationFailureBlock } from "../src/agent/verification/verificationFailureSignal.js";
import { VERIFICATION_FAILURE_TEXT } from "../src/settings/index.js";

describe("renderCiSummary", () => {
  it("formats failing CI fields as plain text for the agent fix prompt", () => {
    const text = formatCiSummaryPlainText({
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
      permissionNote: "Grant Actions: Read for richer digests.",
    });
    expect(text).toBe(
      [
        "❌ CI failing — lint",
        "",
        "lint",
        "https://example.com/lint",
        "src/foo.ts:12 — Unexpected any",
        "Fix the reported lint/format findings locally, then re-push.",
        "",
        "Grant Actions: Read for richer digests.",
      ].join("\n"),
    );
  });

  it("keeps each failure block intact with a blank line between failures", () => {
    const text = formatCiSummaryPlainText({
      status: "failing",
      headline: "❌ CI failing — lint, test",
      failures: [
        {
          name: "lint",
          reason: "Unexpected any",
          fixHint: "Remove the any.",
        },
        {
          name: "test",
          reason: "Assertion failed",
          fixHint: "Update the expectation.",
        },
      ],
    });
    expect(text).toBe(
      [
        "❌ CI failing — lint, test",
        "",
        "lint",
        "Unexpected any",
        "Remove the any.",
        "",
        "test",
        "Assertion failed",
        "Update the expectation.",
      ].join("\n"),
    );
  });

  it("keeps a permission note without failures and drops whitespace-only notes", () => {
    expect(
      formatCiSummaryPlainText({
        status: "failing",
        headline: "❌ CI failing — lint",
        failures: [],
        permissionNote: "Grant Actions: Read for richer digests.",
      }),
    ).toBe(["❌ CI failing — lint", "", "Grant Actions: Read for richer digests."].join("\n"));
    expect(
      formatCiSummaryPlainText({
        status: "passing",
        headline: "✅ All CI is passing",
        failures: [],
        permissionNote: "   \n\t  ",
      }),
    ).toBe("✅ All CI is passing");
  });

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

  it("keeps a verification failure block when the CI cell is refreshed", () => {
    const failure = renderVerificationFailureBlock();
    const original = [
      "## PR Agent Review",
      "",
      `| CI | ${CI_SUMMARY_CELL_START}⏳ CI still running${failure}${CI_SUMMARY_CELL_END} |`,
    ].join("\n");
    const patched = patchCiSummaryCellInCommentBody(original, {
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    });
    expect(patched).toContain("All CI is passing");
    expect(patched).toContain(VERIFICATION_FAILURE_TEXT);
    expect(patched).not.toContain("still running");
  });

  it("returns null when CI cell markers are missing", () => {
    const body = "## PR Agent Review\n\nNo CI cell here.\n";
    expect(commentBodyHasCiSummaryCell(body)).toBe(false);
    expect(
      patchCiSummaryCellInCommentBody(body, {
        status: "passing",
        headline: "✅ All CI is passing",
        failures: [],
      }),
    ).toBeNull();
  });

  it("is a no-op when the replacement cell matches the existing cell", () => {
    const summary: CiSummary = {
      status: "pending",
      headline: "⏳ CI still running",
      failures: [],
    };
    const body = `| CI | ${renderCiSummaryCell(summary)} |`;
    expect(patchCiSummaryCellInCommentBody(body, summary)).toBe(body);
  });

  it("preserves the prior CI table row when a progress rewrite omits CI", () => {
    const ciRow = `<tr><td><strong>CI</strong></td><td>${renderCiSummaryCell({
      status: "pending",
      headline: "⏳ CI is still running",
      failures: [],
    })}</td></tr>`;
    const previous = [
      "<table>",
      "<tbody>",
      "<tr><td><strong>Head</strong></td><td><code>abc</code></td></tr>",
      "<tr><td><strong>Source</strong></td><td>Pull request update</td></tr>",
      ciRow,
      "<tr><td><strong>Recon</strong></td><td>⏳ Running</td></tr>",
      "</tbody>",
      "</table>",
    ].join("\n");
    const next = [
      "<table>",
      "<tbody>",
      "<tr><td><strong>Head</strong></td><td><code>abc</code></td></tr>",
      "<tr><td><strong>Source</strong></td><td>Pull request update</td></tr>",
      "<tr><td><strong>Recon</strong></td><td>✅ Done</td></tr>",
      "</tbody>",
      "</table>",
    ].join("\n");

    const preserved = preserveCiSummaryRowInCommentBody(previous, next);
    expect(preserved).toContain("<strong>CI</strong>");
    expect(preserved).toContain("CI is still running");
    expect(preserved.indexOf("<strong>Source</strong>")).toBeLessThan(
      preserved.indexOf("<strong>CI</strong>"),
    );
    expect(preserved.indexOf("<strong>CI</strong>")).toBeLessThan(
      preserved.indexOf("<strong>Recon</strong>"),
    );
  });

  it("does not duplicate CI when the next body already has a CI cell", () => {
    const ciCell = renderCiSummaryCell({
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    });
    const previous = `<tr><td><strong>CI</strong></td><td>${ciCell}</td></tr>`;
    const next = [
      "<tr><td><strong>Source</strong></td><td>Slash command</td></tr>",
      `<tr><td><strong>CI</strong></td><td>${ciCell}</td></tr>`,
    ].join("\n");
    expect(preserveCiSummaryRowInCommentBody(previous, next)).toBe(next);
  });

  it("keeps a verification failure block when a full summary rewrite already has a CI cell", () => {
    const failure = renderVerificationFailureBlock();
    const previousCell = `${CI_SUMMARY_CELL_START}⏳ CI still running${failure}${CI_SUMMARY_CELL_END}`;
    const nextCell = renderCiSummaryCell({
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    });
    const previous = `<tr><td><strong>CI</strong></td><td>${previousCell}</td></tr>`;
    const next = [
      "<tr><td><strong>Source</strong></td><td>Slash command</td></tr>",
      `<tr><td><strong>CI</strong></td><td>${nextCell}</td></tr>`,
    ].join("\n");
    const preserved = preserveCiSummaryRowInCommentBody(previous, next);
    expect(preserved).toContain("All CI is passing");
    expect(preserved).toContain(VERIFICATION_FAILURE_TEXT);
    expect(preserved).not.toContain("still running");
  });
});
