import type { AppError } from "../../errors/appError.js";
import type { SpecialistReport } from "./specialistReport.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";

export const SPECIALIST_IDS = ["correctness", "security", "quality", "tests"] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];
export type FindingSource = SpecialistId | "review";

export type SpecialistOutcome =
  | {
      readonly kind: "report";
      readonly specialist: SpecialistId;
      readonly report: SpecialistReport & { readonly status: "findings" };
      readonly durationMs: number;
    }
  | {
      readonly kind: "empty";
      readonly specialist: SpecialistId;
      readonly durationMs: number;
    }
  | {
      readonly kind: "error";
      readonly specialist: SpecialistId;
      readonly error: AppError;
      readonly durationMs: number;
    };

export function isFindingSource(value: unknown): value is FindingSource {
  return value === "review" || SPECIALIST_IDS.some((specialist) => specialist === value);
}

export type AcceptedPlacement =
  | {
      readonly kind: "posted" | "resumed";
      readonly source: FindingSource;
      readonly placement: InlinePlacement;
      readonly canonicalFingerprint: string;
      readonly reviewId: number;
    }
  | {
      readonly kind: "summary_only";
      readonly source: FindingSource;
      readonly placement: InlinePlacement;
      readonly canonicalFingerprint: string;
      readonly reason: "historical" | "cap" | "budget" | "anchor";
    };

export type FindingLedger = {
  readonly accepted: readonly AcceptedPlacement[];
  readonly suppressionFingerprints: ReadonlySet<string>;
  readonly inlineReviewIds: readonly number[];
  readonly postedInlineCount: number;
  readonly threadCallCount: number;
  readonly threadBudgetExhausted: boolean;
};

export type FindingLedgerDelta = {
  readonly accepted: readonly AcceptedPlacement[];
  readonly suppressionFingerprints: readonly string[];
  readonly inlineReviewIds: readonly number[];
  readonly postedInlineCount: number;
  readonly threadCallCount: number;
  readonly threadBudgetExhausted: boolean;
};

export function createFindingLedger(initial?: {
  readonly accepted?: readonly AcceptedPlacement[];
  readonly suppressionFingerprints?: Iterable<string>;
  readonly inlineReviewIds?: readonly number[];
  readonly postedInlineCount?: number;
  readonly threadCallCount?: number;
  readonly threadBudgetExhausted?: boolean;
}): FindingLedger {
  return {
    accepted: [...(initial?.accepted ?? [])],
    suppressionFingerprints: new Set(initial?.suppressionFingerprints ?? []),
    inlineReviewIds: [...new Set(initial?.inlineReviewIds ?? [])],
    postedInlineCount: initial?.postedInlineCount ?? 0,
    threadCallCount: initial?.threadCallCount ?? 0,
    threadBudgetExhausted: initial?.threadBudgetExhausted ?? false,
  };
}

export function applyFindingLedgerDelta(
  ledger: FindingLedger,
  delta: FindingLedgerDelta,
): FindingLedger {
  return {
    accepted: [...ledger.accepted, ...delta.accepted],
    suppressionFingerprints: new Set([
      ...ledger.suppressionFingerprints,
      ...delta.suppressionFingerprints,
    ]),
    inlineReviewIds: [...new Set([...ledger.inlineReviewIds, ...delta.inlineReviewIds])],
    postedInlineCount: ledger.postedInlineCount + delta.postedInlineCount,
    threadCallCount: ledger.threadCallCount + delta.threadCallCount,
    threadBudgetExhausted: ledger.threadBudgetExhausted || delta.threadBudgetExhausted,
  };
}
