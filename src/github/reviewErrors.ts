import { isCancelAbortError } from "../agent/providers/providerErrors.ts";
import { isAppError } from "../errors/appError.ts";
import { githubErrorMessage, isProvenInlineAnchorRejection } from "./githubErrors.ts";
import { isKnownNoAcceptanceMutationError } from "./mutationErrorContract.ts";

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value == null) return undefined;
  return Reflect.get(value, key);
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

function hintAtErrorLevel(error: unknown): LineResolutionPublishErrorHint | null {
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

export function lineResolutionPublishErrorHint(
  error: unknown,
): LineResolutionPublishErrorHint | null {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const hint = hintAtErrorLevel(current);
    if (hint != null) return hint;
    current = objectValue(current, "cause");
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

export function isInlineAnchorPublishError(error: unknown): boolean {
  return isLineResolutionPublishError(error) || isProvenInlineAnchorRejection(error);
}

export function isDefinitelyNoAcceptanceReviewError(error: unknown): boolean {
  return isKnownNoAcceptanceMutationError(error) || isLineResolutionPublishError(error);
}

export function publicationAttemptRejected(error: unknown): boolean {
  if (isCancelAbortError(error)) return false;
  if (isAppError(error)) {
    if (
      error.code === "agent_work.pr_actor_lease_lost" ||
      error.code === "operation_intent.mutation_outcome_unknown"
    ) {
      return false;
    }
    if (error.code === "operation_intent.mutation_failed") return true;
  }
  return isDefinitelyNoAcceptanceReviewError(error);
}
