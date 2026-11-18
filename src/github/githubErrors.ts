import { isAppError } from "../errors/appError.ts";
import { httpStatus } from "./httpStatus.ts";

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function validationErrors(error: unknown) {
  if (!isRecord(error)) return ((pinnedReturn: readonly RecordLike[]) => pinnedReturn)([]);

  const response = isRecord(error.response) ? error.response : undefined;
  const responseData =
    response !== undefined && isRecord(response.data) ? response.data : undefined;
  const data = responseData ?? (isRecord(error.data) ? error.data : error);
  const errors = data.errors;
  if (!Array.isArray(errors)) return ((pinnedReturn: readonly RecordLike[]) => pinnedReturn)([]);
  return ((pinnedReturn: readonly RecordLike[]) => pinnedReturn)(errors.filter(isRecord));
}

function errorCause(error: unknown) {
  if (error instanceof Error) return ((pinnedReturn: unknown) => pinnedReturn)(error.cause);
  if (!isRecord(error) || !Object.hasOwn(error, "cause"))
    return ((pinnedReturn: unknown) => pinnedReturn)(undefined);
  return ((pinnedReturn: unknown) => pinnedReturn)(error.cause);
}

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    current = errorCause(current);
  }
  return ((pinnedReturn: readonly unknown[]) => pinnedReturn)(chain);
}

function markedAccepted(error: unknown) {
  if (!isRecord(error)) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (error.accepted === true || error.mutationAccepted === true)
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  const response = isRecord(error.response) ? error.response : undefined;
  if (response == null) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (response.accepted === true || response.mutationAccepted === true)
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  const data = isRecord(response.data) ? response.data : undefined;
  return ((pinnedReturn: boolean) => pinnedReturn)(
    data != null && (data.accepted === true || data.mutationAccepted === true),
  );
}

function anchorValidationMessage(message: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    /line could not be resolved/i.test(message) ||
      /path could not be resolved/i.test(message) ||
      /pull request review thread line.*invalid/i.test(message) ||
      /must be part of the diff/i.test(message),
  );
}

function anchorValidationEntry(entry: RecordLike) {
  const resource = entry.resource;
  if (resource !== undefined && resource !== "PullRequestReview")
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  if (entry.code === "already_exists" || entry.code === "duplicate")
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    typeof entry.message === "string" && anchorValidationMessage(entry.message),
  );
}

function levelProvesInlineAnchorRejection(error: unknown) {
  if (httpStatus(error) !== 422) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const errors = validationErrors(error);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    errors.length > 0 && errors.every(anchorValidationEntry),
  );
}

export function isProvenInlineAnchorRejection(error: unknown) {
  const chain = errorChain(error);
  if (chain.some(markedAccepted)) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(chain.some(levelProvesInlineAnchorRejection));
}

export function isDuplicateCheckRunCreationError(error: unknown) {
  if (httpStatus(error) !== 422) return ((pinnedReturn: boolean) => pinnedReturn)(false);

  return ((pinnedReturn: boolean) => pinnedReturn)(
    validationErrors(error).some((validationError) => {
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
    }),
  );
}

export type GithubErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "unknown";

const MAX_GITHUB_REQUEST_PATH_LEN = 200;

export function githubRequestPath(error: unknown) {
  if (!isRecord(error)) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const request = isRecord(error.request) ? error.request : undefined;
  const fromRequestUrl = pathnameFromKnownUrl(request?.url);
  if (fromRequestUrl != null)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(fromRequestUrl);
  const fromRequestPath = allowlistedRequestPath(request?.path);
  if (fromRequestPath != null)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(fromRequestPath);
  const response = isRecord(error.response) ? error.response : undefined;
  return ((pinnedReturn: string | undefined) => pinnedReturn)(pathnameFromKnownUrl(response?.url));
}

function pathnameFromKnownUrl(value: unknown) {
  if (typeof value !== "string" || value.length === 0)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  try {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      allowlistedRequestPath(new URL(value).pathname),
    );
  } catch {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(allowlistedRequestPath(value));
  }
}

function allowlistedRequestPath(value: unknown) {
  if (typeof value !== "string")
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const path = value.split("?")[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//"))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (path.length > MAX_GITHUB_REQUEST_PATH_LEN) {
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      path.slice(0, MAX_GITHUB_REQUEST_PATH_LEN),
    );
  }
  return ((pinnedReturn: string | undefined) => pinnedReturn)(path);
}

export function githubErrorMessage(error: unknown) {
  if (error instanceof Error) return ((pinnedReturn: string) => pinnedReturn)(error.message);
  if (typeof error === "object" && error != null && "message" in error) {
    return ((pinnedReturn: string) => pinnedReturn)(String(error.message));
  }
  return ((pinnedReturn: string) => pinnedReturn)(String(error));
}

export function isSelfPullRequestReviewEventRejection(error: unknown) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    errorChain(error).some((level) => {
      if (httpStatus(level) !== 422) return false;
      const response = isRecord(level) && isRecord(level.response) ? level.response : undefined;
      const data = response != null && isRecord(response.data) ? response.data : undefined;
      const responseMessage = typeof data?.message === "string" ? data.message : "";
      const text = `${githubErrorMessage(level)} ${responseMessage}`.toLowerCase();
      return (
        text.includes("can not approve your own pull request") ||
        text.includes("can not request changes on your own pull request")
      );
    }),
  );
}

function githubErrorText(error: unknown) {
  if (error instanceof Error)
    return ((pinnedReturn: string) => pinnedReturn)(`${error.name} ${error.message}`.toLowerCase());
  return ((pinnedReturn: string) => pinnedReturn)(githubErrorMessage(error).toLowerCase());
}

export function classifyGithubError(error: unknown) {
  if (
    isAppError(error) &&
    (error.code === "github.review_thread_resolution_denied" ||
      error.code === "github.essential_access_denied")
  ) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("forbidden");
  }
  const text = githubErrorText(error);
  const status = httpStatus(error);

  if (/api rate limit|secondary rate|abuse detection|\b429\b/.test(text) || status === 429) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("rate_limit");
  }
  if (
    /resource not accessible by integration|insufficient.?scopes|requires.?authentication/.test(
      text,
    ) ||
    (status === 403 && /not accessible|forbidden/.test(text))
  ) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("forbidden");
  }
  if (status === 401 || /\b401\b|unauthorized|bad credentials|authentication/.test(text)) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("auth");
  }
  if (status === 403 || /\b403\b|forbidden/.test(text)) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("forbidden");
  }
  if (status === 404 || /\b404\b|not found/.test(text)) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("not_found");
  }
  if (status === 422 || /validation failed|unprocessable entity|\b422\b/.test(text)) {
    return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("validation");
  }
  return ((pinnedReturn: GithubErrorKind) => pinnedReturn)("unknown");
}

export function looksLikeGithubError(error: unknown) {
  if (isAppError(error))
    return ((pinnedReturn: boolean) => pinnedReturn)(error.domain === "github");
  if (isRecord(error)) {
    const request = isRecord(error.request) ? error.request : undefined;
    const response = isRecord(error.response) ? error.response : undefined;
    const headers = isRecord(response?.headers) ? response.headers : undefined;
    if (typeof headers?.["x-github-request-id"] === "string")
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
    for (const url of [request?.url, response?.url]) {
      if (typeof url !== "string") continue;
      try {
        if (new URL(url).hostname === "api.github.com")
          return ((pinnedReturn: boolean) => pinnedReturn)(true);
      } catch {}
    }
  }
  const text = githubErrorText(error);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    /resource not accessible by integration|graphqlresponseerror|octokit|github api|secondary rate|api rate limit exceeded/.test(
      text,
    ),
  );
}
