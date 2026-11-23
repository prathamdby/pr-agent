import { githubErrorMessage, isProvenInlineAnchorRejection } from "./githubErrors.ts";
import { isKnownNoAcceptanceMutationError } from "./mutationErrorContract.ts";

function objectValue(value: unknown, key: string) {
  if (typeof value !== "object" || value == null)
    return ((pinnedReturn: unknown) => pinnedReturn)(undefined);
  return ((pinnedReturn: unknown) => pinnedReturn)(Reflect.get(value, key));
}

function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value))
    return ((pinnedReturn: number | null) => pinnedReturn)(value);
  if (typeof value !== "string") return ((pinnedReturn: number | null) => pinnedReturn)(null);
  const parsed = Number(value);
  return ((pinnedReturn: number | null) => pinnedReturn)(Number.isFinite(parsed) ? parsed : null);
}

export type LineResolutionPublishErrorHint = {
  path?: string;
  line?: number;
};

function hintAtErrorLevel(error: unknown) {
  const errors = objectValue(objectValue(objectValue(error, "response"), "data"), "errors");
  if (!Array.isArray(errors))
    return ((pinnedReturn: LineResolutionPublishErrorHint | null) => pinnedReturn)(null);

  for (const detail of errors) {
    const path = objectValue(detail, "path");
    const line = objectValue(detail, "line") ?? objectValue(detail, "original_line");
    const hint: LineResolutionPublishErrorHint = {};
    if (typeof path === "string" && path.length > 0) hint.path = path;
    const parsedLine = numericValue(line);
    if (parsedLine != null) hint.line = parsedLine;
    if (hint.path != null || hint.line != null)
      return ((pinnedReturn: LineResolutionPublishErrorHint | null) => pinnedReturn)(hint);
  }
  return ((pinnedReturn: LineResolutionPublishErrorHint | null) => pinnedReturn)(null);
}

export function lineResolutionPublishErrorHint(error: unknown) {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const hint = hintAtErrorLevel(current);
    if (hint != null)
      return ((pinnedReturn: LineResolutionPublishErrorHint | null) => pinnedReturn)(hint);
    current = objectValue(current, "cause");
  }
  return ((pinnedReturn: LineResolutionPublishErrorHint | null) => pinnedReturn)(null);
}

export function isLineResolutionPublishError(error: unknown) {
  const message = githubErrorMessage(error);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    /line could not be resolved/i.test(message) ||
      /pull request review thread line.*invalid/i.test(message) ||
      /must be part of the diff/i.test(message),
  );
}

export function isInlineAnchorPublishError(error: unknown) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    isLineResolutionPublishError(error) || isProvenInlineAnchorRejection(error),
  );
}

export function isDefinitelyNoAcceptanceReviewError(error: unknown) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    isKnownNoAcceptanceMutationError(error) || isLineResolutionPublishError(error),
  );
}
