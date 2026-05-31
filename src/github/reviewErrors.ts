import { httpStatus } from "./httpStatus.js";

function githubErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error != null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function isLineResolutionPublishError(error: unknown): boolean {
  const message = githubErrorMessage(error);
  return (
    /line could not be resolved/i.test(message) ||
    /pull request review thread line.*invalid/i.test(message) ||
    /must be part of the diff/i.test(message)
  );
}

/** GitHub 422/502/503 errors worth retrying (excludes anchor and validation failures). */
export function isTransientGitHubReviewError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== 422 && status !== 503 && status !== 502) return false;
  if (isLineResolutionPublishError(error)) return false;

  const message = githubErrorMessage(error).toLowerCase();
  if (
    /validation failed|cannot be submitted|review has already been submitted|already been submitted|unprocessable entity/.test(
      message,
    )
  ) {
    return false;
  }

  return true;
}
