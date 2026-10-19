import type { DurableExecutionResult } from "./durableJob.ts";

export type VerificationDegradationReason =
  | "thread_resolution_degraded"
  | "compare_files_truncated"
  | "verdict_mapping_incomplete"
  | "inventory_narrowed"
  | "stale_head"
  | "objection_answers_capped"
  | "objection_detection_incomplete";

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

export const STALE_VERIFICATION_RESULT = {
  kind: "completed",
  degradation: ["stale_head"] satisfies readonly VerificationDegradationReason[],
} as const satisfies DurableExecutionResult;
