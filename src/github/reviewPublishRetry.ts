import { REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS } from "../settings/index.js";
import { nonErrorThrown } from "../errors/appError.js";
import { isTransientGitHubReviewError } from "./reviewErrors.js";

export async function withTransientReviewRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : nonErrorThrown("github.review_publish_retry");
      lastError = err;
      if (attempt >= delaysMs.length || !isTransientGitHubReviewError(err)) {
        throw err;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delaysMs[attempt]);
      });
    }
  }
  throw lastError ?? nonErrorThrown("github.review_publish_retry");
}
