import { githubErrorMessage } from "./githubErrors.js";
import { isKnownNoAcceptanceMutationError } from "../agentWork/withOperationIntent.js";

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

/** A review retry is safe only when the provider proves rejection before acceptance. */
export function isTransientGitHubReviewError(error: unknown): boolean {
  return isKnownNoAcceptanceMutationError(error) && !isLineResolutionPublishError(error);
}

/**
 * A retry is safe only when the provider explicitly proves that the review was
 * rejected before acceptance, or when the error is a validation-only anchor
 * rejection handled by the placement fallback.
 */
export function isDefinitelyNoAcceptanceReviewError(error: unknown): boolean {
  return isKnownNoAcceptanceMutationError(error) || isLineResolutionPublishError(error);
}
