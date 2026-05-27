import { REVIEW_PUBLISH_TRANSIENT_RETRY_DELAYS_MS } from "../settings/index.js";
import { isLineResolutionPublishError, githubErrorMessage } from "../agent/reviewDiffPlacement.js";

export function isTransientGitHubReviewError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status !== 422 && status !== 503 && status !== 502) return false;
  if (isLineResolutionPublishError(error)) return false;
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      await sleep(delaysMs[attempt]!);
    }
  }
  throw lastError;
}
