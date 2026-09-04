import type { DurableExecutionResult } from "./durableJob.js";

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
  degraded: true,
} as const satisfies DurableExecutionResult;
