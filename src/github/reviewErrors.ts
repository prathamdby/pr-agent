import { httpStatus } from "./httpStatus.js";

function githubErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error != null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value == null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type LineResolutionPublishErrorHint = {
  path?: string;
  line?: number;
};

export function lineResolutionPublishErrorHint(
  error: unknown,
): LineResolutionPublishErrorHint | null {
  const errors = objectValue(objectValue(objectValue(error, "response"), "data"), "errors");
  if (!Array.isArray(errors)) return null;

  for (const detail of errors) {
    const path = objectValue(detail, "path");
    const line = objectValue(detail, "line") ?? objectValue(detail, "original_line");
    const hint: LineResolutionPublishErrorHint = {};
    if (typeof path === "string" && path.length > 0) hint.path = path;
    const parsedLine = numericValue(line);
    if (parsedLine != null) hint.line = parsedLine;
    if (hint.path != null || hint.line != null) return hint;
  }
  return null;
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
