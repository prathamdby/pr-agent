import { httpStatus } from "./httpStatus.js";

export type GithubErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "unknown";

export function githubErrorMessage(error: Error): string {
  return error.message;
}

function githubErrorText(error: Error): string {
  return `${error.name} ${error.message}`.toLowerCase();
}

/** Logs/analytics-only classification for GitHub API failures. */
export function classifyGithubError(error: Error): GithubErrorKind {
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

export function looksLikeGithubError(error: Error): boolean {
  if (httpStatus(error) != null) return true;
  const text = githubErrorText(error);
  return /resource not accessible by integration|graphqlresponseerror|octokit|github api|secondary rate|api rate limit exceeded/.test(
    text,
  );
}
