import crypto from "node:crypto";
import { REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE } from "../../settings/index.js";
import type {
  FingerprintedInlinePlacement,
  InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import {
  LEGACY_REVIEW_LENSES,
  type LegacyReviewLens,
  type ReviewFinding,
} from "../reviewSchema.js";

export function normalizeFindingSubstance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function fingerprintFinding(finding: ReviewFinding): string {
  return fingerprintFindingForLens(finding);
}

function fingerprintFindingForLens(finding: ReviewFinding, lens?: LegacyReviewLens): string {
  const lineBucket = Math.floor(finding.startLine / REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE);
  const findingMaterial = [
    finding.file,
    normalizeFindingSubstance(finding.title),
    normalizeFindingSubstance(finding.detail),
    String(lineBucket),
  ];
  const material = lens == null ? findingMaterial : [lens, ...findingMaterial];
  return crypto.createHash("sha256").update(material.join("|")).digest("hex").slice(0, 16);
}

function fingerprintLegacyFinding(finding: ReviewFinding, lens: LegacyReviewLens): string {
  return fingerprintFindingForLens(finding, lens);
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
): FingerprintedInlinePlacement[] {
  return placements.map((placement) => ({
    ...placement,
    inlineFingerprint: fingerprintFinding(placement.finding),
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
    const matchesHistoricalFingerprint = LEGACY_REVIEW_LENSES.some((lens) =>
      stored.has(fingerprintLegacyFinding(placement.finding, lens)),
    );
    if (!stored.has(placement.inlineFingerprint) && !matchesHistoricalFingerprint) {
      return placement;
    }
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
