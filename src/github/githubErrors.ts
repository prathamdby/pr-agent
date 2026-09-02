import { httpStatus } from "./httpStatus.js";

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function validationErrors(error: unknown): readonly RecordLike[] {
  if (!isRecord(error)) return [];

  const response = isRecord(error.response) ? error.response : undefined;
  const responseData =
    response !== undefined && isRecord(response.data) ? response.data : undefined;
  const data = responseData ?? (isRecord(error.data) ? error.data : error);
  const errors = data.errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter(isRecord);
}

/**
 * Check-run creation recovery is safe only for a structured duplicate signal.
 * A bare 422 is a generic validation failure and must remain unresolved.
 */
export function isDuplicateCheckRunCreationError(error: unknown): boolean {
  if (httpStatus(error) !== 422) return false;

  return validationErrors(error).some((validationError) => {
    const resource = validationError.resource;
    if (resource !== undefined && resource !== "CheckRun") return false;

    if (validationError.code === "already_exists" || validationError.code === "duplicate") {
      return true;
    }

    return (
      validationError.code === "custom" &&
      typeof validationError.message === "string" &&
      /\b(?:already exists|duplicate)\b/i.test(validationError.message)
    );
  });
}

export type GithubErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "unknown";

/** Message string for unknown errors (GitHub helpers share this). */
export function githubErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error != null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function githubErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLowerCase();
  return githubErrorMessage(error).toLowerCase();
}

/** Logs/analytics-only classification for GitHub API failures. */
export function classifyGithubError(error: unknown): GithubErrorKind {
  const text = githubErrorText(error);
  const status = httpStatus(error);

  if (/api rate limit|secondary rate|abuse detection|\b429\b/.test(text) || status === 429) {
    return "rate_limit";
  }
  if (
    /resource not accessible by integration|insufficient.?scopes|requires.?authentication/.test(
      text,
    ) ||
    (status === 403 && /not accessible|forbidden/.test(text))
  ) {
    return "forbidden";
  }
  if (status === 401 || /\b401\b|unauthorized|bad credentials|authentication/.test(text)) {
    return "auth";
  }
  if (status === 403 || /\b403\b|forbidden/.test(text)) {
    return "forbidden";
  }
  if (status === 404 || /\b404\b|not found/.test(text)) {
    return "not_found";
  }
  if (status === 422 || /validation failed|unprocessable entity|\b422\b/.test(text)) {
    return "validation";
  }
  return "unknown";
}

export function looksLikeGithubError(error: unknown): boolean {
  if (httpStatus(error) != null) return true;
  const text = githubErrorText(error);
  // Require GitHub-shaped signals — do not treat bare 401/403 strings as GitHub
  // (provider adapters often surface those without an HTTP status field).
  return /resource not accessible by integration|graphqlresponseerror|octokit|github api|secondary rate|api rate limit exceeded/.test(
    text,
  );
}
