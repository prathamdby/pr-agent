import crypto from "node:crypto";
import { REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE } from "../../settings/index.js";
import { LEGACY_REVIEW_LENSES, type AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type {
  FingerprintedInlinePlacement,
  InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import type { ReviewFinding, ReviewMode } from "../reviewSchema.js";

export function normalizeFindingSubstance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function fingerprintFindingInBucket(
  finding: ReviewFinding,
  mode: AnyReviewLens,
  lineBucket: number,
): string {
  const material = [
    mode,
    finding.file,
    normalizeFindingSubstance(finding.title),
    normalizeFindingSubstance(finding.detail),
    String(lineBucket),
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function fingerprintFinding(finding: ReviewFinding, mode: AnyReviewLens): string {
  const lineBucket = Math.floor(finding.startLine / REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE);
  return fingerprintFindingInBucket(finding, mode, lineBucket);
}

/** New fingerprints hash under review; suppression also checks historical lenses and adjacent line buckets. */
export function fingerprintCandidates(finding: ReviewFinding): readonly string[] {
  const currentBucket = Math.floor(finding.startLine / REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE);
  const lineBuckets =
    currentBucket === 0
      ? [currentBucket, currentBucket + 1]
      : [currentBucket, currentBucket - 1, currentBucket + 1];
  const reviewLenses: readonly AnyReviewLens[] = ["review", ...LEGACY_REVIEW_LENSES];
  const candidates = new Set<string>();
  for (const lineBucket of lineBuckets) {
    for (const lens of reviewLenses) {
      candidates.add(fingerprintFindingInBucket(finding, lens, lineBucket));
    }
  }
  return [...candidates];
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
    if (!fingerprintCandidates(placement.finding).some((candidate) => stored.has(candidate))) {
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
