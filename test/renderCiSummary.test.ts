import { describe, expect, it } from "vitest";
import {
  CI_PROJECTION_FORMAT,
  CI_SUMMARY_CELL_END,
  CI_SUMMARY_CELL_START,
  commentBodyHasCiSummaryCell,
  formatCiSummaryPlainText,
  parseCiSummaryMarkerHead,
  parseCiSummaryMarkerVersion,
  renderCiSummaryCell,
  shouldIncludeCiInAgentFixPrompt,
  shouldRenderCiSummaryRow,
} from "../src/review/ci/renderCiSummary.js";
import {
  applyCiProjectionBodyUpdate,
  parseCiSummaryMarker,
  replaceCiSummaryCellIfNewer,
  renderCiActionPhrase,
} from "../src/review/ci/ciSummaryCell.js";
import type { CiSummary } from "../src/review/ci/ciSummaryTypes.js";
import { renderVerificationFailureBlock } from "../src/review/ci/verificationFailureBlock.js";
import { VERIFICATION_FAILURE_TEXT } from "../src/settings/index.js";
import { formatReviewActionLineCiStatus } from "../src/review/ci/ciActionPhrase.js";

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

  it("renders unavailable permission rows and includes seeded none", () => {
    expect(
      shouldRenderCiSummaryRow({
        status: "unavailable",
        headline: "Grant Checks to Read",
        failures: [],
      }),
    ).toBe(true);
    expect(shouldRenderCiSummaryRow({ status: "none", headline: "x", failures: [] })).toBe(true);
    expect(shouldIncludeCiInAgentFixPrompt({ status: "none", headline: "x", failures: [] })).toBe(
      false,
    );
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

  it("stamps head, version, and format into the CI marker", () => {
    const head = "d".repeat(40);
    const cell = renderCiSummaryCell(
      { status: "passing", headline: "✅ All CI is passing", failures: [] },
      head,
      3,
    );
    expect(cell).toContain(`head=${head}`);
    expect(cell).toContain("v=3");
    expect(cell).toContain(`fmt=${CI_PROJECTION_FORMAT}`);
    expect(
      cell.startsWith(`<!-- pr-agent:ci-summary head=${head} v=3 fmt=${CI_PROJECTION_FORMAT} -->`),
    ).toBe(true);
    expect(parseCiSummaryMarkerHead(cell)).toBe(head);
    expect(parseCiSummaryMarkerVersion(cell)).toBe(3);
    expect(parseCiSummaryMarker(cell)?.format).toBe(CI_PROJECTION_FORMAT);
    expect(
      parseCiSummaryMarkerHead(
        renderCiSummaryCell({ status: "passing", headline: "x", failures: [] }),
      ),
    ).toBeNull();
  });

  it("treats a missing v as older than any stored version", () => {
    const head = "e".repeat(40);
    const body = `| CI | ${renderCiSummaryCell(
      { status: "pending", headline: "⏳ CI still running", failures: [] },
      head,
    )} |`;
    expect(parseCiSummaryMarkerVersion(body)).toBe(0);
    const next = renderCiSummaryCell(
      { status: "passing", headline: "✅ All CI is passing", failures: [] },
      head,
      2,
    );
    const patched = replaceCiSummaryCellIfNewer(body, next, head, 2);
    expect(patched).toContain("All CI is passing");
    expect(patched).toContain("v=2");
    expect(patched).not.toContain("still running");
  });

  it("does not replace a newer or equal marker version", () => {
    const head = "f".repeat(40);
    const body = `| CI | ${renderCiSummaryCell(
      { status: "passing", headline: "✅ All CI is passing", failures: [] },
      head,
      4,
    )} |`;
    const older = renderCiSummaryCell(
      { status: "pending", headline: "⏳ CI still running", failures: [] },
      head,
      3,
    );
    expect(replaceCiSummaryCellIfNewer(body, older, head, 3)).toBeNull();
    expect(replaceCiSummaryCellIfNewer(body, older, head, 4)).toBeNull();
  });

  it("does not replace a cell for a different head", () => {
    const oldHead = "a".repeat(40);
    const newHead = "b".repeat(40);
    const body = `| CI | ${renderCiSummaryCell(
      { status: "failing", headline: "❌ CI failing — lint", failures: [] },
      oldHead,
      1,
    )} |`;
    const next = renderCiSummaryCell(
      { status: "passing", headline: "✅ All CI is passing", failures: [] },
      newHead,
      2,
    );
    expect(replaceCiSummaryCellIfNewer(body, next, newHead, 2)).toBeNull();
  });

  it("does not preserve an old verification failure block unless the next cell includes it", () => {
    const head = "g".repeat(40);
    const failure = renderVerificationFailureBlock();
    const original = [
      "## PR Agent Review",
      "",
      `| CI | ${CI_SUMMARY_CELL_START}⏳ CI still running${failure}${CI_SUMMARY_CELL_END} |`,
    ].join("\n");
    const next = renderCiSummaryCell(
      { status: "passing", headline: "✅ All CI is passing", failures: [] },
      head,
      1,
    );
    const patched = replaceCiSummaryCellIfNewer(original, next, head, 1);
    expect(patched).toContain("All CI is passing");
    expect(patched).not.toContain(VERIFICATION_FAILURE_TEXT);
    expect(patched).not.toContain("still running");

    const withFailure = replaceCiSummaryCellIfNewer(
      original,
      `${next.slice(0, -CI_SUMMARY_CELL_END.length)}${failure}${CI_SUMMARY_CELL_END}`,
      head,
      1,
    );
    expect(withFailure).toContain(VERIFICATION_FAILURE_TEXT);
  });

  it("upgrades equal-revision legacy markers once and rejects lower revisions", () => {
    const head = "h".repeat(40);
    const legacyCell = `<!-- pr-agent:ci-summary head=${head} v=2 -->⏳ Waiting for CI<!-- /pr-agent:ci-summary -->`;
    const body = [
      "## PR Agent Review",
      "",
      "> [!NOTE]",
      "> No findings, ready to merge. CI is pending. All specialists ran with full coverage.",
      "",
      `| CI | ${legacyCell} |`,
      "",
      `Identical text elsewhere: CI is pending`,
    ].join("\n");
    const next = renderCiSummaryCell(
      { status: "none", headline: "No CI checks on this head", failures: [] },
      head,
      2,
    );
    const phrase = formatReviewActionLineCiStatus({
      status: "none",
      headline: "No CI checks on this head",
      failures: [],
    });
    const upgraded = applyCiProjectionBodyUpdate(body, next, head, 2, { actionPhrase: phrase });
    expect(upgraded?.kind).toBe("updated");
    expect(upgraded?.body).toContain("No CI checks on this head");
    expect(upgraded?.body).toContain(renderCiActionPhrase(phrase));
    expect(upgraded?.body).not.toContain("⏳ Waiting for CI");
    expect(upgraded?.body).toContain("Identical text elsewhere: CI is pending");

    const current = applyCiProjectionBodyUpdate(upgraded!.body, next, head, 2, {
      actionPhrase: phrase,
    });
    expect(current?.kind).toBe("current");

    expect(
      applyCiProjectionBodyUpdate(upgraded!.body, next, head, 1, { actionPhrase: phrase }),
    ).toBeNull();
  });

  it("updates cell and action phrase together on a greater revision", () => {
    const head = "i".repeat(40);
    const body = [
      "## PR Agent Review",
      "",
      "> [!NOTE]",
      `> No findings, ready to merge. ${renderCiActionPhrase("CI is pending")}. All specialists ran with full coverage.`,
      "",
      `| CI | ${renderCiSummaryCell({ status: "pending", headline: "⏳ Waiting for CI", failures: [] }, head, 1)} |`,
    ].join("\n");
    const next = renderCiSummaryCell(
      { status: "none", headline: "No CI checks on this head", failures: [] },
      head,
      2,
    );
    const patched = replaceCiSummaryCellIfNewer(body, next, head, 2, {
      actionPhrase: "No CI checks ran on this head",
    });
    expect(patched).toContain("No CI checks on this head");
    expect(patched).toContain(renderCiActionPhrase("No CI checks ran on this head"));
    expect(patched).not.toContain("Waiting for CI");
    expect(patched).not.toContain(">No findings, ready to merge. CI is pending.");
  });

  it("returns null when CI cell markers are missing", () => {
    const body = "## PR Agent Review\n\nNo CI cell here.\n";
    expect(commentBodyHasCiSummaryCell(body)).toBe(false);
    expect(
      replaceCiSummaryCellIfNewer(
        body,
        renderCiSummaryCell({ status: "passing", headline: "✅ All CI is passing", failures: [] }),
        "abc",
        1,
      ),
    ).toBeNull();
  });
});
