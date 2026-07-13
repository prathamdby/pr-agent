import { normalizeFindingSubstance } from "../findings/reviewFindingFingerprint.js";
import { REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE } from "../../settings/index.js";
import type { ReviewFinding } from "../reviewSchema.js";

/** A finding reduced to its adjudication-relevant substance for comparison. */
export type NormalizedFinding = {
  readonly file: string;
  readonly lineBucket: number;
  readonly normalizedTitle: string;
  readonly severity: string;
};

/** An adjudicated expected finding from the replay manifest. */
export type AdjudicatedFinding = {
  readonly id: string;
  readonly file: string;
  readonly lineBucket: number;
  readonly normalizedTitle: string;
  readonly severity: string;
  readonly valid: boolean;
};

export type ComparisonEntry = {
  readonly adjudicatedId: string | null;
  readonly legacy: NormalizedFinding | null;
  readonly hybrid: NormalizedFinding | null;
  readonly status: "matched" | "legacy-only" | "hybrid-only" | "both-missed";
};

export type ComparisonResult = {
  readonly entries: readonly ComparisonEntry[];
  readonly legacyCount: number;
  readonly hybridCount: number;
  readonly matchedCount: number;
  readonly legacyOnlyCount: number;
  readonly hybridOnlyCount: number;
};

export type GateResult = {
  readonly recallPass: boolean;
  readonly falsePositivePass: boolean;
  readonly recallRate: number;
  readonly falsePositiveRate: number;
  readonly details: string;
};

/** Minimum historical cases required for replay gate evaluation (R24). */
export const MIN_REPLAY_CASES = 50;

/** Minimum paired shadow Reviews required for shadow gate evaluation (R24). */
export const MIN_SHADOW_REVIEWS = 300;

/** Minimum shadow observation window in days (R24). */
export const MIN_SHADOW_DAYS = 7;

/** Maximum allowed false-positive regression in percentage points at 95% confidence (R24). */
export const MAX_FP_REGRESSION_PERCENTAGE_POINTS = 2;

export function normalizeFinding(finding: ReviewFinding): NormalizedFinding {
  return {
    file: finding.file,
    lineBucket: Math.floor(finding.startLine / REVIEW_FINDING_FINGERPRINT_LINE_BUCKET_SIZE),
    normalizedTitle: normalizeFindingSubstance(finding.title),
    severity: finding.severity,
  };
}

function findingKey(f: {
  readonly file: string;
  readonly lineBucket: number;
  readonly normalizedTitle: string;
}): string {
  return `${f.file}|${f.lineBucket}|${f.normalizedTitle}`;
}

/**
 * Compare legacy and hybrid normalized findings against adjudicated expected
 * outcomes. A finding matches when file, line bucket, and normalized title
 * agree. Findings not in the adjudicated set are counted as potential false
 * positives.
 */
export function compareFindings(params: {
  readonly legacy: readonly NormalizedFinding[];
  readonly hybrid: readonly NormalizedFinding[];
  readonly adjudicated: readonly AdjudicatedFinding[];
}): ComparisonResult {
  const adjudicatedByKey = new Map(params.adjudicated.map((a) => [findingKey(a), a]));
  const legacyByKey = new Map(params.legacy.map((f) => [findingKey(f), f]));
  const hybridByKey = new Map(params.hybrid.map((f) => [findingKey(f), f]));
  const allKeys = new Set([...legacyByKey.keys(), ...hybridByKey.keys()]);

  const entries: ComparisonEntry[] = [];
  let matched = 0;
  let legacyOnly = 0;
  let hybridOnly = 0;

  for (const key of allKeys) {
    const legacy = legacyByKey.get(key) ?? null;
    const hybrid = hybridByKey.get(key) ?? null;
    const adjudicated = adjudicatedByKey.get(key);
    let status: ComparisonEntry["status"];
    if (legacy && hybrid) {
      status = "matched";
      matched += 1;
    } else if (legacy && !hybrid) {
      status = "legacy-only";
      legacyOnly += 1;
    } else if (!legacy && hybrid) {
      status = "hybrid-only";
      hybridOnly += 1;
    } else {
      status = "both-missed";
    }
    entries.push({
      adjudicatedId: adjudicated?.id ?? null,
      legacy,
      hybrid,
      status,
    });
  }

  return {
    entries,
    legacyCount: params.legacy.length,
    hybridCount: params.hybrid.length,
    matchedCount: matched,
    legacyOnlyCount: legacyOnly,
    hybridOnlyCount: hybridOnly,
  };
}

/**
 * Evaluate launch gates from a comparison result.
 *
 * - Recall gate: every adjudicated valid P0-P2 found by legacy must also appear
 *   in hybrid. A hybrid-only valid finding is an improvement, not a failure.
 * - False-positive gate: hybrid's observed false-positive rate must not exceed
 *   legacy's by more than the configured tolerance.
 */
export function evaluateGates(params: {
  readonly comparison: ComparisonResult;
  readonly adjudicated: readonly AdjudicatedFinding[];
  readonly legacyCaseCount: number;
  readonly shadowReviewCount?: number;
  readonly shadowDays?: number;
}): GateResult {
  const { comparison, adjudicated } = params;
  const validAdjudicated = adjudicated.filter((a) => a.valid);
  const validKeys = new Set(validAdjudicated.map((a) => findingKey(a)));

  const legacyValidFound = comparison.entries.filter(
    (e) => e.legacy && validKeys.has(findingKey(e.legacy)),
  ).length;
  const hybridValidFound = comparison.entries.filter(
    (e) => e.hybrid && validKeys.has(findingKey(e.hybrid)),
  ).length;

  const recallRate = validAdjudicated.length > 0 ? hybridValidFound / validAdjudicated.length : 1;
  const recallPass = hybridValidFound >= legacyValidFound;

  const legacyFalsePositives = comparison.entries.filter(
    (e) => e.legacy && !validKeys.has(findingKey(e.legacy)),
  ).length;
  const hybridFalsePositives = comparison.entries.filter(
    (e) => e.hybrid && !validKeys.has(findingKey(e.hybrid)),
  ).length;
  const legacyFpRate =
    comparison.legacyCount > 0 ? legacyFalsePositives / comparison.legacyCount : 0;
  const hybridFpRate =
    comparison.hybridCount > 0 ? hybridFalsePositives / comparison.hybridCount : 0;
  const fpRegression = (hybridFpRate - legacyFpRate) * 100;
  const falsePositivePass = fpRegression <= MAX_FP_REGRESSION_PERCENTAGE_POINTS;

  const caseCountPass = params.legacyCaseCount >= MIN_REPLAY_CASES;
  const shadowCountPass = (params.shadowReviewCount ?? 0) >= MIN_SHADOW_REVIEWS;
  const shadowDaysPass = (params.shadowDays ?? 0) >= MIN_SHADOW_DAYS;

  const details = [
    `Recall: ${hybridValidFound}/${validAdjudicated.length} valid findings found (legacy found ${legacyValidFound}), rate=${recallRate.toFixed(3)}, pass=${recallPass}`,
    `False-positive: legacy=${legacyFpRate.toFixed(3)}, hybrid=${hybridFpRate.toFixed(3)}, regression=${fpRegression.toFixed(1)}pp, pass=${falsePositivePass}`,
    `Case count: ${params.legacyCaseCount}/${MIN_REPLAY_CASES} required, pass=${caseCountPass}`,
    `Shadow: ${params.shadowReviewCount ?? 0}/${MIN_SHADOW_REVIEWS} reviews, ${params.shadowDays ?? 0}/${MIN_SHADOW_DAYS} days, pass=${shadowCountPass && shadowDaysPass}`,
  ].join("; ");

  return {
    recallPass,
    falsePositivePass,
    recallRate,
    falsePositiveRate: hybridFpRate,
    details,
  };
}
