import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
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
    const a = fingerprintFinding(finding);
    const b = fingerprintFinding(finding);
    expect(a).toBe(b);
  });

  it("differs when detail changes", () => {
    const other = { ...finding, detail: "different substance" };
    expect(fingerprintFinding(finding)).not.toBe(fingerprintFinding(other));
  });

  it("matches when a finding shifts within the same line bucket", () => {
    const shifted = { ...finding, startLine: 13, endLine: 15 };
    expect(fingerprintFinding(finding)).toBe(fingerprintFinding(shifted));
  });

  it("differs when title changes", () => {
    const other = { ...finding, title: "Leaked token" };
    expect(fingerprintFinding(finding)).not.toBe(fingerprintFinding(other));
  });

  it("differs for identical findings in distant line buckets", () => {
    const distant = { ...finding, startLine: 400, endLine: 402 };
    expect(fingerprintFinding(finding)).not.toBe(fingerprintFinding(distant));
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
    const fingerprint = fingerprintFinding(finding);
    const fingerprintedPlacements = fingerprintInlinePlacements([
      {
        finding,
        inlineLine: 10,
        inlinePosted: true,
      },
    ]);
    const { placements, suppressedInlineCount } = suppressInlinePlacementsByFingerprint(
      fingerprintedPlacements,
      [fingerprint],
    );
    expect(suppressedInlineCount).toBe(1);
    expect(placements[0]?.inlinePosted).toBe(false);
  });

  it("suppresses findings recorded under a historical lens fingerprint", () => {
    const legacyMaterial = [
      "review-security",
      finding.file,
      "missing null check",
      "payload may be null",
      "0",
    ].join("|");
    const legacyFingerprint = crypto
      .createHash("sha256")
      .update(legacyMaterial)
      .digest("hex")
      .slice(0, 16);
    const fingerprintedPlacements = fingerprintInlinePlacements([
      { finding, inlineLine: 10, inlinePosted: true },
    ]);

    const result = suppressInlinePlacementsByFingerprint(fingerprintedPlacements, [
      legacyFingerprint,
    ]);

    expect(result.suppressedInlineCount).toBe(1);
    expect(result.placements[0]?.inlinePosted).toBe(false);
  });
});

describe("mergeInlineFingerprintRecords", () => {
  it("merges prior and new fingerprints", () => {
    const placements = fingerprintInlinePlacements([
      { finding, inlineLine: 10, inlinePosted: true },
    ]);
    const merged = mergeInlineFingerprintRecords(["old"], placements);
    expect(merged).toContain("old");
    expect(merged).toContain(fingerprintFinding(finding));
  });
});
