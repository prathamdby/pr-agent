import crypto from "node:crypto";
import { REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE } from "../../settings/index.js";
import type {
  FingerprintedInlinePlacement,
  InlinePlacement,
} from "../placement/reviewDiffPlacement.js";
import type { ReviewFinding } from "../reviewSchema.js";
import { LEGACY_REVIEW_LENSES, type AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import { isJsonString, type JsonObject } from "../../util/jsonValue.js";

export function normalizeFindingSubstance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function fingerprintFinding(finding: ReviewFinding, mode: AnyReviewLens): string {
  const lineBucket = Math.floor(finding.startLine / REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE);
  return fingerprintFindingInLineBucket(finding, mode, lineBucket);
}

function fingerprintFindingInLineBucket(
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

export function fingerprintCandidates(finding: ReviewFinding): readonly string[] {
  const currentBucket = Math.floor(finding.startLine / REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE);
  const buckets = [currentBucket, currentBucket - 1, currentBucket + 1].filter(
    (bucket) => bucket >= 0,
  );
  const modes: readonly AnyReviewLens[] = ["review", ...LEGACY_REVIEW_LENSES];
  return buckets.flatMap((bucket) =>
    modes.map((mode) => fingerprintFindingInLineBucket(finding, mode, bucket)),
  );
}

export type StoredInlineFingerprints = {
  readonly fingerprints: readonly string[];
};

export function parseStoredInlineFingerprints(
  detail: JsonObject | null | undefined,
): StoredInlineFingerprints {
  const raw = detail?.fingerprints;
  if (!Array.isArray(raw)) return { fingerprints: [] };
  return {
    fingerprints: raw.filter((entry): entry is string => isJsonString(entry)),
  };
}

export function fingerprintInlinePlacements(
  placements: readonly InlinePlacement[],
  mode: AnyReviewLens,
): FingerprintedInlinePlacement[] {
  return placements.map((placement) => ({
    ...placement,
    inlineFingerprint: fingerprintFinding(placement.finding, mode),
  }));
}

export type SuppressInlinePlacementsResult = {
  readonly placements: FingerprintedInlinePlacement[];
  readonly suppressedInlineCount: number;
};

export function suppressInlinePlacementsByFingerprint(
  placements: readonly FingerprintedInlinePlacement[],
  storedFingerprints: readonly string[],
): SuppressInlinePlacementsResult {
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
