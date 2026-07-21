import { describe, expect, it } from "vitest";
import {
  fingerprintCandidates,
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

  it("suppresses a finding stored under a historical review lens", () => {
    const stored = fingerprintFinding(finding, "review-security");
    const fingerprintedPlacements = fingerprintInlinePlacements(
      [{ finding, inlineLine: 10, inlinePosted: true }],
      "review",
    );

    const result = suppressInlinePlacementsByFingerprint(fingerprintedPlacements, [stored]);

    expect(result.suppressedInlineCount).toBe(1);
    expect(result.placements[0]?.inlinePosted).toBe(false);
  });

  it("suppresses a finding stored in an adjacent line bucket", () => {
    const shifted = { ...finding, startLine: 50, endLine: 52 };
    const stored = fingerprintFinding(finding, "review");
    const fingerprintedPlacements = fingerprintInlinePlacements(
      [{ finding: shifted, inlineLine: 50, inlinePosted: true }],
      "review",
    );

    const result = suppressInlinePlacementsByFingerprint(fingerprintedPlacements, [stored]);

    expect(result.suppressedInlineCount).toBe(1);
    expect(result.placements[0]?.inlinePosted).toBe(false);
  });
});

describe("fingerprintCandidates", () => {
  it("includes historical lenses and adjacent line buckets", () => {
    const shifted = { ...finding, startLine: 50, endLine: 52 };
    const candidates = fingerprintCandidates(shifted);

    expect(candidates).toContain(fingerprintFinding(shifted, "review-security"));
    expect(candidates).toContain(fingerprintFinding(finding, "review"));
    expect(candidates).toContain(fingerprintFinding(finding, "review-security"));
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
