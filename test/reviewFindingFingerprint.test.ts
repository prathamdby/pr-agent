import { describe, expect, it } from "vitest";
import {
  fingerprintFinding,
  mergeInlineFingerprintRecords,
  parseStoredInlineFingerprints,
  suppressInlinePlacementsByFingerprint,
} from "../src/review/reviewFindingFingerprint.js";
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
    const { placements, suppressedInlineCount } = suppressInlinePlacementsByFingerprint(
      [
        {
          finding,
          inlineLine: 10,
          inlinePosted: true,
        },
      ],
      "review",
      [fingerprint],
    );
    expect(suppressedInlineCount).toBe(1);
    expect(placements[0]?.inlinePosted).toBe(false);
  });
});

describe("mergeInlineFingerprintRecords", () => {
  it("merges prior and new fingerprints", () => {
    const merged = mergeInlineFingerprintRecords(["old"], [finding], "review");
    expect(merged).toContain("old");
    expect(merged).toContain(fingerprintFinding(finding, "review"));
  });
});
