import { describe, expect, it } from "vitest";
import {
  formatReviewDuration,
  renderReviewRunFooter,
  resolveReviewWallClockMs,
  reviewLensFooterLabel,
  shortHeadSha,
} from "../src/review/run/reviewRunFooter.js";

describe("reviewLensFooterLabel", () => {
  it("uses one footer label for recognized review lenses", () => {
    expect(reviewLensFooterLabel("review")).toBe("general");
    expect(reviewLensFooterLabel("review-security")).toBe("general");
    expect(reviewLensFooterLabel("review-quality")).toBe("general");
    expect(reviewLensFooterLabel("review-tests")).toBe("general");
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

  it("formats multi-day hour totals without wrapping", () => {
    expect(formatReviewDuration(360_000_000)).toBe("100h");
    expect(formatReviewDuration(90_060_000)).toBe("25h 1m");
  });

  it("clamps non-finite and negative values to 0s", () => {
    expect(formatReviewDuration(-5)).toBe("0s");
    expect(formatReviewDuration(Number.NaN)).toBe("0s");
  });
});

describe("resolveReviewWallClockMs", () => {
  it("prefers stub start over metrics start", () => {
    expect(
      resolveReviewWallClockMs({
        stubPostedAtMs: 1_000,
        metricsStartedAtMs: 2_000,
        endedAtMs: 5_000,
      }),
    ).toBe(4_000);
  });

  it("falls back to metrics start when stub time is missing", () => {
    expect(
      resolveReviewWallClockMs({
        stubPostedAtMs: null,
        metricsStartedAtMs: 2_000,
        endedAtMs: 5_000,
      }),
    ).toBe(3_000);
  });

  it("returns 0 when neither start is known", () => {
    expect(
      resolveReviewWallClockMs({
        stubPostedAtMs: null,
        metricsStartedAtMs: null,
        endedAtMs: 5_000,
      }),
    ).toBe(0);
  });

  it("clamps inverted clocks to 0", () => {
    expect(
      resolveReviewWallClockMs({
        stubPostedAtMs: 9_000,
        metricsStartedAtMs: 1_000,
        endedAtMs: 5_000,
      }),
    ).toBe(0);
  });
});

describe("shortHeadSha", () => {
  it("returns the first 7 hex characters", () => {
    expect(shortHeadSha("abc123def456")).toBe("abc123d");
    expect(shortHeadSha("ABCDEF0123456789")).toBe("abcdef0");
  });

  it("handles minimum and maximum valid SHA lengths", () => {
    expect(shortHeadSha("abcdef1")).toBe("abcdef1");
    expect(shortHeadSha("a".repeat(40))).toBe("aaaaaaa");
    expect(shortHeadSha("a".repeat(41))).toBe("unknown");
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
    ).toBe("<sub>abc1234 ⋅ general ⋅ 1s ⋅ evil&lt;script&gt;</sub>");
  });

  it("falls back to unknown for empty or whitespace-only model", () => {
    expect(
      renderReviewRunFooter({
        headSha: "abc1234",
        mode: "review",
        durationMs: 1_000,
        model: "",
      }),
    ).toBe("<sub>abc1234 ⋅ general ⋅ 1s ⋅ unknown</sub>");
    expect(
      renderReviewRunFooter({
        headSha: "abc1234",
        mode: "review",
        durationMs: 1_000,
        model: "   ",
      }),
    ).toBe("<sub>abc1234 ⋅ general ⋅ 1s ⋅ unknown</sub>");
  });
});
