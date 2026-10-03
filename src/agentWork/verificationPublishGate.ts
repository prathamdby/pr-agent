import type { DurableExecutionResult } from "./durableJob.js";

/** Reasons a verification run completed with reduced output. */
export type VerificationDegradationReason =
  | "thread_resolution_degraded"
  | "compare_files_truncated"
  | "verdict_mapping_incomplete"
  | "inventory_narrowed"
  | "stale_head";

export type VerificationHeadFreshness =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "stale";
      readonly boundHeadSha: string;
      readonly latestHeadSha: string;
    };

export function verificationHeadFreshness(
  boundHeadSha: string,
  latestHeadSha: string,
): VerificationHeadFreshness {
  if (boundHeadSha === latestHeadSha) return { kind: "fresh" };
  return { kind: "stale", boundHeadSha, latestHeadSha };
}

/** Terminal for a run that never examined the live head. */
export const STALE_VERIFICATION_RESULT = {
  kind: "completed",
  degradation: ["stale_head"] satisfies readonly VerificationDegradationReason[],
} as const satisfies DurableExecutionResult;
