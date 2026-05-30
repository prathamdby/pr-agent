import crypto from "node:crypto";
import type { InlinePlacement } from "./reviewDiffPlacement.js";
import type { ReviewFinding, ReviewMode } from "./reviewSchema.js";

export function normalizeFindingSubstance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function fingerprintFinding(finding: ReviewFinding, mode: ReviewMode): string {
  const material = [
    mode,
    finding.file,
    String(finding.startLine),
    String(finding.endLine),
    normalizeFindingSubstance(finding.title),
    normalizeFindingSubstance(finding.detail),
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function fingerprintFindings(
  findings: readonly ReviewFinding[],
  mode: ReviewMode,
): string[] {
  return findings.map((finding) => fingerprintFinding(finding, mode));
}

export type StoredInlineFingerprints = {
  readonly fingerprints: readonly string[];
};

export function parseStoredInlineFingerprints(
  detail: Record<string, unknown> | null | undefined,
): StoredInlineFingerprints {
  const raw = detail?.fingerprints;
  if (!Array.isArray(raw)) return { fingerprints: [] };
  return {
    fingerprints: raw.filter((entry): entry is string => typeof entry === "string"),
  };
}

export function suppressInlinePlacementsByFingerprint(
  placements: readonly InlinePlacement[],
  mode: ReviewMode,
  storedFingerprints: readonly string[],
): { placements: InlinePlacement[]; suppressedInlineCount: number } {
  const stored = new Set(storedFingerprints);
  let suppressedInlineCount = 0;
  const next = placements.map((placement) => {
    if (!placement.inlinePosted) return placement;
    const fingerprint = fingerprintFinding(placement.finding, mode);
    if (!stored.has(fingerprint)) return placement;
    suppressedInlineCount += 1;
    return { ...placement, inlinePosted: false };
  });
  return { placements: next, suppressedInlineCount };
}

export function mergeInlineFingerprintRecords(
  existing: readonly string[],
  findings: readonly ReviewFinding[],
  mode: ReviewMode,
): string[] {
  return [...new Set([...existing, ...fingerprintFindings(findings, mode)])];
}
