import crypto from "node:crypto";
import type { FingerprintedInlinePlacement, InlinePlacement } from "./reviewDiffPlacement.js";
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

export function fingerprintInlinePlacements(
  placements: readonly InlinePlacement[],
  mode: ReviewMode,
): FingerprintedInlinePlacement[] {
  return placements.map((placement) => ({
    ...placement,
    inlineFingerprint: fingerprintFinding(placement.finding, mode),
  }));
}

export function suppressInlinePlacementsByFingerprint(
  placements: readonly FingerprintedInlinePlacement[],
  storedFingerprints: readonly string[],
): { placements: FingerprintedInlinePlacement[]; suppressedInlineCount: number } {
  const stored = new Set(storedFingerprints);
  let suppressedInlineCount = 0;
  const next = placements.map((placement) => {
    if (!placement.inlinePosted) return placement;
    if (!stored.has(placement.inlineFingerprint)) return placement;
    suppressedInlineCount += 1;
    return { ...placement, inlinePosted: false };
  });
  return { placements: next, suppressedInlineCount };
}

export function mergeInlineFingerprintRecords(
  existing: readonly string[],
  placements: readonly FingerprintedInlinePlacement[],
): string[] {
  return [...new Set([...existing, ...placements.map((placement) => placement.inlineFingerprint)])];
}
