import { describe, expect, it } from "vitest";
import { renderCiSummaryCell, shouldRenderCiSummaryRow } from "../src/review/ci/renderCiSummary.js";
import type { CiSummary } from "../src/review/ci/ciSummaryTypes.js";

describe("renderCiSummary", () => {
  it("renders a passing headline", () => {
    const summary: CiSummary = {
      status: "passing",
      headline: "✅ All CI is passing",
      failures: [],
    };
    expect(renderCiSummaryCell(summary)).toContain("All CI is passing");
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
});
