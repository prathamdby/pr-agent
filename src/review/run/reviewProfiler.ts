import type { ReviewWorkExtras } from "../../analytics/workCompleted.js";
import type { ReviewRunMetricsSnapshot } from "./reviewRunMetrics.js";

export type ReviewWorkClaim = {
  readonly createdAt: Date;
  readonly startedAt: Date;
  readonly attemptCount: number;
};

export function reviewWorkExtras(input: {
  readonly snapshot: ReviewRunMetricsSnapshot | null;
  readonly provider: string;
  readonly model: string;
  readonly reviewLens?: string;
  readonly source?: "auto" | "slash";
}): ReviewWorkExtras {
  return {
    model: input.model,
    provider: input.provider,
    ...(input.reviewLens != null ? { reviewLens: input.reviewLens } : {}),
    ...(input.source != null ? { source: input.source } : {}),
    ...(input.snapshot
      ? {
          findingsCount: input.snapshot.findingsCount,
          specialistReport: input.snapshot.specialistOutcomes?.report ?? 0,
          specialistEmpty: input.snapshot.specialistOutcomes?.empty ?? 0,
          specialistError: input.snapshot.specialistOutcomes?.error ?? 0,
        }
      : {}),
  };
}
