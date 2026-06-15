import { describe, expect, it } from "vitest";
import {
  fingerprintFinding,
  fingerprintInlinePlacements,
  mergeInlineFingerprintRecords,
  parseStoredInlineFingerprints,
  suppressInlinePlacementsByFingerprint,
} from "../src/review/findings/reviewFindingFingerprint.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";

const finding: ReviewFinding = {
  severity: "P1",
  file: "src/a.ts",
  startLine: 10,
  endLine: 12,
  title: "Missing null check",
  detail: "payload may be null",
  fixPrompt: "Add a guard before dereferencing payload.",
};

describe("fingerprintFinding", () => {
  it("is stable for the same finding", () => {
    const a = fingerprintFinding(finding, "review");
    const b = fingerprintFinding(finding, "review");
    expect(a).toBe(b);
  });

  it("differs by mode", () => {
    expect(fingerprintFinding(finding, "review")).not.toBe(
      fingerprintFinding(finding, "review-security"),
    );
  });

  it("differs when detail changes", () => {
    const other = { ...finding, detail: "different substance" };
    expect(fingerprintFinding(finding, "review")).not.toBe(fingerprintFinding(other, "review"));
  });

  it("matches when a finding shifts within the same line bucket", () => {
    const shifted = { ...finding, startLine: 13, endLine: 15 };
    expect(fingerprintFinding(finding, "review")).toBe(fingerprintFinding(shifted, "review"));
  });

  it("differs when title changes", () => {
    const other = { ...finding, title: "Leaked token" };
    expect(fingerprintFinding(finding, "review")).not.toBe(fingerprintFinding(other, "review"));
  });

  it("differs for identical findings in distant line buckets", () => {
    const distant = { ...finding, startLine: 400, endLine: 402 };
    expect(fingerprintFinding(finding, "review")).not.toBe(fingerprintFinding(distant, "review"));
  });
});

describe("parseStoredInlineFingerprints", () => {
  it("reads fingerprint arrays from publish detail", () => {
    expect(parseStoredInlineFingerprints({ fingerprints: ["abc", 1, "def"] })).toEqual({
      fingerprints: ["abc", "def"],
    });
  });
});

describe("suppressInlinePlacementsByFingerprint", () => {
  it("suppresses inline posting for stored fingerprints only", () => {
    const fingerprint = fingerprintFinding(finding, "review");
    const fingerprintedPlacements = fingerprintInlinePlacements(
      [
        {
          finding,
          inlineLine: 10,
          inlinePosted: true,
        },
      ],
      "review",
    );
    const { placements, suppressedInlineCount } = suppressInlinePlacementsByFingerprint(
      fingerprintedPlacements,
      [fingerprint],
    );
    expect(suppressedInlineCount).toBe(1);
    expect(placements[0]?.inlinePosted).toBe(false);
  });
});

describe("mergeInlineFingerprintRecords", () => {
  it("merges prior and new fingerprints", () => {
    const placements = fingerprintInlinePlacements(
      [{ finding, inlineLine: 10, inlinePosted: true }],
      "review",
    );
    const merged = mergeInlineFingerprintRecords(["old"], placements);
    expect(merged).toContain("old");
    expect(merged).toContain(fingerprintFinding(finding, "review"));
  });
});
