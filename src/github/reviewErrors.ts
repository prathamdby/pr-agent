import * as v from "valibot";
import { githubErrorMessage } from "./githubErrors.js";
import { httpStatus } from "./httpStatus.js";
import { isJsonNumber, isJsonString, jsonValueSchema } from "../util/jsonValue.js";

const githubReviewErrorDetailSchema = v.object({
  path: v.optional(v.string()),
  line: v.optional(v.union([v.number(), v.string()])),
  original_line: v.optional(v.union([v.number(), v.string()])),
});

const githubReviewErrorResponseSchema = v.object({
  response: v.object({
    data: v.object({
      errors: v.array(jsonValueSchema),
    }),
  }),
});

function numericValue(value: string | number): number | null {
  if (isJsonNumber(value) && Number.isFinite(value)) return value;
  if (!isJsonString(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type LineResolutionPublishErrorHint = {
  path?: string;
  line?: number;
};

export function lineResolutionPublishErrorHint(
  error: Error,
): LineResolutionPublishErrorHint | null {
  const parsed = v.safeParse(githubReviewErrorResponseSchema, error);
  if (!parsed.success) return null;

  for (const item of parsed.output.response.data.errors) {
    const detail = v.safeParse(githubReviewErrorDetailSchema, item);
    if (!detail.success) continue;
    const hint: LineResolutionPublishErrorHint = {};
    if (detail.output.path != null && detail.output.path.length > 0) {
      hint.path = detail.output.path;
    }
    const line = detail.output.line ?? detail.output.original_line;
    if (line !== undefined) {
      const parsedLine = numericValue(line);
      if (parsedLine != null) hint.line = parsedLine;
    }
    if (hint.path != null || hint.line != null) return hint;
  }
  return null;
}

export function isLineResolutionPublishError(error: Error): boolean {
  const message = githubErrorMessage(error);
  return (
    /line could not be resolved/i.test(message) ||
    /pull request review thread line.*invalid/i.test(message) ||
    /must be part of the diff/i.test(message)
  );
}

/** GitHub 422/502/503 errors worth retrying (excludes anchor and validation failures). */
export function isTransientGitHubReviewError(error: Error): boolean {
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
