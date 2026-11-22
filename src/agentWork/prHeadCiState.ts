import {
  isCheckFactPending,
  type CiCheckFact,
  type CiRollup,
  type CiSourceAvailability,
} from "../review/ci/ciFacts.ts";

export type PrHeadCiStateRow = {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly checks: Record<string, CiCheckFact>;
  readonly rollup: CiRollup;
  readonly version: number;
  readonly authored: unknown;
  readonly prNumbers: unknown;
  readonly truncated: boolean;
  readonly seededAt: Date | null;
  readonly projectionRepairPending: boolean;
  readonly firstSeenAt: Date;
  readonly updatedAt: Date;
  readonly sourceAvailability?: CiSourceAvailability;
};

export function headCiNeedsSeed(row: { readonly seededAt: Date | number | null } | null) {
  return ((pinnedReturn: boolean) => pinnedReturn)(row == null || row.seededAt == null);
}

export type HeadCiListingPhase = "seed" | "pending-refresh" | "none";
const UNKNOWN_CI_READ_LIMIT = 3;

export function headCiListingPhase(
  row:
    | (Pick<PrHeadCiStateRow, "checks" | "rollup" | "sourceAvailability"> & {
        readonly seededAt: Date | number | null;
      })
    | null,
) {
  if (row?.sourceAvailability != null) {
    const availability = row.sourceAvailability;
    const needsListing = (["checks", "statuses"] as const).some((source) => {
      const state = availability[source];
      if (state.access === "denied") return false;
      if (state.access === "unknown" && (state.unknownReadCount ?? 0) >= UNKNOWN_CI_READ_LIMIT)
        return false;
      return (
        state.access === "unknown" ||
        state.listingRequired ||
        Object.values(row.checks).some(
          (fact) =>
            fact.source === (source === "checks" ? "check_run" : "status") &&
            isCheckFactPending(fact),
        )
      );
    });
    if (!needsListing) return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("none");
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)(
      row.seededAt == null ? "seed" : "pending-refresh",
    );
  }
  if (row == null || row.seededAt == null)
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("seed");
  if (row.rollup === "unknown")
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("pending-refresh");
  if (Object.values(row.checks).some(isCheckFactPending))
    return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("pending-refresh");
  return ((pinnedReturn: HeadCiListingPhase) => pinnedReturn)("none");
}

export function asPrNumbers(value: unknown) {
  if (!Array.isArray(value)) return ((pinnedReturn: number[]) => pinnedReturn)([]);
  const numbers: number[] = [];
  for (const entry of value) {
    const n = typeof entry === "number" ? entry : Number(entry);
    if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  }
  return ((pinnedReturn: number[]) => pinnedReturn)(numbers);
}

export type VerificationSignalPrior = {
  readonly active: boolean;
  readonly headSha: string | null;
};

export function isEffectiveVerificationSignalTransition(
  prior: VerificationSignalPrior | null,
  next: { readonly active: boolean; readonly headSha: string },
) {
  const wasActive = prior?.active === true;
  if (next.active) {
    if (!wasActive) return ((pinnedReturn: boolean) => pinnedReturn)(true);
    return ((pinnedReturn: boolean) => pinnedReturn)(prior?.headSha !== next.headSha);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(wasActive && prior?.headSha === next.headSha);
}
