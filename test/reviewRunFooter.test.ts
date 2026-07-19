import { describe, expect, it } from "vitest";
import {
  formatReviewDuration,
  renderReviewRunFooter,
  reviewLensFooterLabel,
  shortHeadSha,
} from "../src/review/run/reviewRunFooter.js";

describe("reviewLensFooterLabel", () => {
  it("maps each review mode to a short lens label", () => {
    expect(reviewLensFooterLabel("review")).toBe("general");
    expect(reviewLensFooterLabel("review-security")).toBe("security");
    expect(reviewLensFooterLabel("review-quality")).toBe("quality");
    expect(reviewLensFooterLabel("review-tests")).toBe("tests");
  });
});

describe("formatReviewDuration", () => {
  it("formats seconds, minutes, and hours compactly", () => {
    expect(formatReviewDuration(0)).toBe("0s");
    expect(formatReviewDuration(45_000)).toBe("45s");
    expect(formatReviewDuration(60_000)).toBe("1m");
    expect(formatReviewDuration(680_000)).toBe("11m 20s");
    expect(formatReviewDuration(3_720_000)).toBe("1h 2m");
    expect(formatReviewDuration(3_600_000)).toBe("1h");
  });

  it("clamps non-finite and negative values to 0s", () => {
    expect(formatReviewDuration(-5)).toBe("0s");
    expect(formatReviewDuration(Number.NaN)).toBe("0s");
  });
});

describe("shortHeadSha", () => {
  it("returns the first 7 hex characters", () => {
    expect(shortHeadSha("abc123def456")).toBe("abc123d");
    expect(shortHeadSha("ABCDEF0123456789")).toBe("abcdef0");
  });

  it("returns unknown for non-hex SHAs", () => {
    expect(shortHeadSha("not-a-sha")).toBe("unknown");
    expect(shortHeadSha("")).toBe("unknown");
  });
});

describe("renderReviewRunFooter", () => {
  it("renders a muted middot-separated provenance line", () => {
    expect(
      renderReviewRunFooter({
        headSha: "abc123def456",
        mode: "review",
        durationMs: 680_000,
        model: "grok-4.5",
      }),
    ).toBe("<sub>abc123d ⋅ general ⋅ 11m 20s ⋅ grok-4.5</sub>");
  });

  it("escapes HTML-sensitive model text", () => {
    expect(
      renderReviewRunFooter({
        headSha: "abc1234",
        mode: "review-security",
        durationMs: 1_000,
        model: "evil<script>",
      }),
    ).toBe("<sub>abc1234 ⋅ security ⋅ 1s ⋅ evil&lt;script&gt;</sub>");
  });
});
