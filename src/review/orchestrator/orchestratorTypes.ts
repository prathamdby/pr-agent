import type { AppError } from "../../errors/appError.js";
import type { ReviewCancelAttribution } from "../../settings/index.js";
import type { SpecialistReport } from "./specialistReport.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";
import type { FindingId } from "../findingIdentity/findingMarker.js";

export type AcceptedFindingSlimReference = {
  readonly findingId: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
};
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
      readonly report?: SpecialistReport;
    }
  | {
      readonly kind: "error";
      readonly specialist: SpecialistId;
      readonly error: AppError;
      readonly durationMs: number;
    };

export type ReviewRunGateResult =
  | { readonly kind: "continue" }
  | { readonly kind: "stop"; readonly reason: "superseded" | "stale_head" }
  | {
      readonly kind: "stop";
      readonly reason: "cancelled";
      readonly attribution: ReviewCancelAttribution;
    }
  | { readonly kind: "finalize"; readonly reason: "deadline" };

export type ReviewRunTiming = {
  readonly returnByMs: number;
  readonly modelStopAtMs: number;
  readonly remainingModelMs: (now?: number) => number;
  readonly remainingTotalMs: (now?: number) => number;
};

export type ReviewRunGate = {
  readonly check: () => Promise<ReviewRunGateResult>;
};

export type SpecialistRunPhase =
  | { readonly phase: "waiting" }
  | { readonly phase: "running" }
  | { readonly phase: "done"; readonly findingsAccepted: number }
  | { readonly phase: "no_findings" }
  | { readonly phase: "failed" };

export type ReconRunPhase = "running" | "done";

type OrchestratedRunLifecycle =
  | { readonly kind: "running" }
  | { readonly kind: "stopped"; readonly reason: "superseded" | "stale_head" }
  | {
      readonly kind: "stopped";
      readonly reason: "cancelled";
      readonly attribution: ReviewCancelAttribution;
    }
  | { readonly kind: "finalizing"; readonly reason: "deadline" }
  | { readonly kind: "complete" };

type OrchestratedSummaryState =
  | { readonly kind: "pending" }
  | { readonly kind: "published" }
  | { readonly kind: "failed" };

export type OrchestratedRunState = {
  recon: ReconRunPhase;
  readonly specialists: Record<SpecialistId, SpecialistRunPhase>;
  readonly outcomes: Partial<Record<SpecialistId, SpecialistOutcome>>;
  readonly completionOrder: SpecialistId[];
  readonly failedSpecialists: SpecialistId[];
  briefFallback: boolean;
  judgment: "model" | "degraded";
  lifecycle: OrchestratedRunLifecycle;
  progressRevision: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  summary: OrchestratedSummaryState;
};

export function isFindingSource(value: unknown): value is FindingSource {
  return value === "review" || SPECIALIST_IDS.some((specialist) => specialist === value);
}

export type SummaryOnlyReason =
  | "cap"
  | "budget"
  | "anchor"
  | "inventory_incomplete"
  | "unanswered_overlap";

export type AcceptedPlacement =
  | {
      readonly kind: "posted" | "resumed";
      readonly source: FindingSource;
      readonly placement: InlinePlacement;
      readonly findingId: FindingId;
      readonly canonicalFingerprint: string;
      readonly reviewId: number;
      readonly reopens?: FindingId;
    }
  | {
      readonly kind: "summary_only";
      readonly source: FindingSource;
      readonly placement: InlinePlacement;
      readonly findingId: FindingId;
      readonly canonicalFingerprint: string;
      readonly reason: SummaryOnlyReason;
      readonly reopens?: FindingId;
    };

export type ReaffirmedFinding = {
  readonly id: FindingId;
  readonly source: FindingSource;
  readonly severity: InlinePlacement["finding"]["severity"];
  readonly heldBy: "thread" | "summary" | "run";
  readonly placement: InlinePlacement;
};

export type FindingLedger = {
  readonly accepted: readonly AcceptedPlacement[];
  readonly reaffirmed: readonly ReaffirmedFinding[];
  readonly suppressedDismissedCount: number;
  readonly inlineReviewIds: readonly number[];
  readonly postedInlineCount: number;
  readonly threadCallCount: number;
  readonly threadBudgetExhausted: boolean;
};

export type FindingLedgerDelta = {
  readonly accepted: readonly AcceptedPlacement[];
  readonly reaffirmed: readonly ReaffirmedFinding[];
  readonly suppressedDismissedCount: number;
  readonly inlineReviewIds: readonly number[];
  readonly postedInlineCount: number;
  readonly threadCallCount: number;
  readonly threadBudgetExhausted: boolean;
};

export type ReviewCoverage =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly failed: readonly SpecialistId[]; readonly note: string }
  | { readonly kind: "none"; readonly failed: readonly SpecialistId[] };

export function createFindingLedger(initial?: {
  readonly accepted?: readonly AcceptedPlacement[];
  readonly reaffirmed?: readonly ReaffirmedFinding[];
  readonly suppressedDismissedCount?: number;
  readonly inlineReviewIds?: readonly number[];
  readonly postedInlineCount?: number;
  readonly threadCallCount?: number;
  readonly threadBudgetExhausted?: boolean;
}): FindingLedger {
  return {
    accepted: [...(initial?.accepted ?? [])],
    reaffirmed: [...(initial?.reaffirmed ?? [])],
    suppressedDismissedCount: initial?.suppressedDismissedCount ?? 0,
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
    reaffirmed: [...ledger.reaffirmed, ...delta.reaffirmed],
    suppressedDismissedCount: ledger.suppressedDismissedCount + delta.suppressedDismissedCount,
    inlineReviewIds: [...new Set([...ledger.inlineReviewIds, ...delta.inlineReviewIds])],
    postedInlineCount: ledger.postedInlineCount + delta.postedInlineCount,
    threadCallCount: ledger.threadCallCount + delta.threadCallCount,
    threadBudgetExhausted: ledger.threadBudgetExhausted || delta.threadBudgetExhausted,
  };
}

export function carriedReaffirmedFindings(ledger: FindingLedger): ReaffirmedFinding[] {
  const seen = new Set<FindingId>(ledger.accepted.map((accepted) => accepted.findingId));
  return ledger.reaffirmed.filter((entry) => {
    if (entry.heldBy === "run" || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

export function ledgerFindings(ledger: FindingLedger): InlinePlacement["finding"][] {
  return [
    ...ledger.accepted.map((accepted) => accepted.placement.finding),
    ...carriedReaffirmedFindings(ledger).map((entry) => entry.placement.finding),
  ];
}

export function countAcceptedForSource(ledger: FindingLedger, source: FindingSource): number {
  return (
    ledger.accepted.filter((placement) => placement.source === source).length +
    ledger.reaffirmed.filter((entry) => entry.source === source).length
  );
}

export function specialistDonePhase(
  ledgerBefore: FindingLedger,
  ledgerAfter: FindingLedger,
  source: SpecialistId,
): Extract<SpecialistRunPhase, { phase: "done" }> {
  return {
    phase: "done",
    findingsAccepted:
      countAcceptedForSource(ledgerAfter, source) - countAcceptedForSource(ledgerBefore, source),
  };
}
