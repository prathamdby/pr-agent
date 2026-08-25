import { REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS } from "../settings/index.js";
import {
  isDefinitelyNoAcceptanceReviewError,
  isLineResolutionPublishError,
} from "./reviewErrors.js";

/** Kept as a named policy for callers that need a safe retry predicate. */
export function isTransientGitHubReviewError(error: unknown): boolean {
  return isDefinitelyNoAcceptanceReviewError(error) && !isLineResolutionPublishError(error);
}

export async function withTransientReviewRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= delaysMs.length || !isTransientGitHubReviewError(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delaysMs[attempt]);
      });
    }
  }
  throw lastError;
}
