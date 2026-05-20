import { RequestError } from "@octokit/request-error";
import type { ResponseHeaders } from "@octokit/types";
import { logWarn, logDebug } from "../evlog.js";

export type GithubToolErrorClassification =
  | "token_expired"
  | "secondary_rate_limit"
  | "rate_limit"
  | "probable_secondary"
  | "auth"
  | "other";

export type RetryAfterSource = "header" | "x-ratelimit-reset" | "default" | "plugin-fallback";

const TOKEN_FRESHNESS_BUFFER_MS = 60_000;
const DEFAULT_COOLDOWN_SECONDS = 60;
const MESSAGE_TRUNCATE = 500;

const SECONDARY_RATE_MESSAGE = /\bsecondary rate\b/i;
const BAD_CREDENTIALS_MESSAGE = /bad credentials/i;

export type InstallationTokenContext = {
  readonly expiresAtTs: number;
  readonly ttlMs?: number;
  readonly now?: number;
};

export type GithubToolLogContext = InstallationTokenContext & {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly mode: string;
};

export type ClassifiedGithubError = {
  readonly classification: GithubToolErrorClassification;
  readonly pluginPrimaryRateLimit: boolean;
  readonly pluginSecondaryRateLimit: boolean;
  readonly retryAfterSeconds: number;
  readonly retryAfterSource: RetryAfterSource;
};

export function isGithubRequestError(err: unknown): err is RequestError {
  return (
    err instanceof RequestError ||
    (typeof err === "object" &&
      err !== null &&
      (err as RequestError).name === "HttpError" &&
      typeof (err as RequestError).status === "number")
  );
}

function graphqlRateLimitErrors(err: unknown): Array<{ type?: string }> {
  const e = err as {
    errors?: Array<{ type?: string }>;
    data?: { errors?: Array<{ type?: string }> };
    response?: { errors?: Array<{ type?: string }>; data?: { errors?: Array<{ type?: string }> } };
  };
  return e.errors ?? e.response?.errors ?? e.data?.errors ?? e.response?.data?.errors ?? [];
}

export function isGraphqlRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // @octokit/plugin-throttling (wrap-request.js)
  if (err.message === "GraphQL Rate Limit Exceeded") return true;
  // @octokit/graphql GraphqlResponseError exposes errors on err.errors / err.response.errors
  return graphqlRateLimitErrors(err).some((e) => e.type === "RATE_LIMITED");
}

function headerString(headers: ResponseHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const v = headers[name as keyof ResponseHeaders];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

// GitHub installation tokens are valid for one hour; use when expiresAt is missing at mint.
export const INSTALLATION_TOKEN_FALLBACK_TTL_MS = 60 * 60 * 1000;

// GitHub does not return issued-at; infer from expiresAt using min(observed TTL, 1h cap)
const MAX_ASSUMED_INSTALLATION_TOKEN_TTL_MS = INSTALLATION_TOKEN_FALLBACK_TTL_MS;

export function getTokenTiming(
  expiresAtTs: number,
  now: number = Date.now(),
  ttlMs?: number,
): { tokenAgeSeconds: number; tokenExpiresInSeconds: number } {
  const tokenExpiresInSeconds = Math.max(0, Math.floor((expiresAtTs - now) / 1000));
  const observedTtlMs = Math.max(0, expiresAtTs - now);
  const effectiveTtlMs =
    ttlMs ??
    (observedTtlMs > 0 ? Math.min(MAX_ASSUMED_INSTALLATION_TOKEN_TTL_MS, observedTtlMs) : 0);
  const issuedAtTs = expiresAtTs - effectiveTtlMs;
  const tokenAgeSeconds = Math.max(0, Math.floor((now - issuedAtTs) / 1000));
  return { tokenAgeSeconds, tokenExpiresInSeconds };
}

export function isInstallationTokenNearExpiry(
  expiresAtTs: number,
  now: number = Date.now(),
): boolean {
  return now >= expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS;
}

export function extractGithubResponseMeta(err: RequestError): {
  status: number;
  message: string;
  method: string | undefined;
  url: string | undefined;
  githubRequestId: string | undefined;
  rateLimitResource: string | undefined;
  rateLimitRemaining: string | undefined;
  rateLimitLimit: string | undefined;
  rateLimitReset: string | undefined;
  rateLimitUsed: string | undefined;
  retryAfterHeader: string | undefined;
  octokitRetryCount: number | undefined;
  pluginPrimaryRateLimit: boolean;
  pluginSecondaryRateLimit: boolean;
} {
  const headers = err.response?.headers;
  const message = err.message.slice(0, MESSAGE_TRUNCATE);
  return {
    status: err.status,
    message,
    method: err.request?.method,
    url: err.request?.url,
    githubRequestId: headerString(headers, "x-github-request-id"),
    rateLimitResource: headerString(headers, "x-ratelimit-resource"),
    rateLimitRemaining: headerString(headers, "x-ratelimit-remaining"),
    rateLimitLimit: headerString(headers, "x-ratelimit-limit"),
    rateLimitReset: headerString(headers, "x-ratelimit-reset"),
    rateLimitUsed: headerString(headers, "x-ratelimit-used"),
    retryAfterHeader: headerString(headers, "retry-after"),
    octokitRetryCount: (() => {
      const rc = (err.request as unknown as { retryCount?: number }).retryCount;
      return typeof rc === "number" ? rc : undefined;
    })(),
    pluginPrimaryRateLimit: isPrimaryRateLimitExceeded(message, headers),
    pluginSecondaryRateLimit: SECONDARY_RATE_MESSAGE.test(message),
  };
}

function isPrimaryRateLimitExceeded(
  message: string,
  headers: ResponseHeaders | undefined,
): boolean {
  if (headerString(headers, "x-ratelimit-remaining") !== "0") return false;
  if (SECONDARY_RATE_MESSAGE.test(message)) return false;
  const retryAfter = headerString(headers, "retry-after");
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed > 0) return false;
  }
  const resource = headerString(headers, "x-ratelimit-resource");
  if (resource == null) return false;
  return resource === "core" || resource === "search";
}

export function classifyGithubToolError(
  err: unknown,
  ctx: InstallationTokenContext,
): ClassifiedGithubError {
  const now = ctx.now ?? Date.now();

  if (isGraphqlRateLimitError(err)) {
    return {
      classification: "rate_limit",
      pluginPrimaryRateLimit: true,
      pluginSecondaryRateLimit: false,
      retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      retryAfterSource: "default",
    };
  }

  if (!isGithubRequestError(err)) {
    if (isInstallationTokenNearExpiry(ctx.expiresAtTs, now)) {
      return {
        classification: "token_expired",
        pluginPrimaryRateLimit: false,
        pluginSecondaryRateLimit: false,
        retryAfterSeconds: 0,
        retryAfterSource: "default",
      };
    }
    return {
      classification: "other",
      pluginPrimaryRateLimit: false,
      pluginSecondaryRateLimit: false,
      retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      retryAfterSource: "default",
    };
  }

  const meta = extractGithubResponseMeta(err);
  const retry = resolveRetryAfter(meta, now);

  if (meta.pluginSecondaryRateLimit) {
    return {
      classification: "secondary_rate_limit",
      pluginPrimaryRateLimit: meta.pluginPrimaryRateLimit,
      pluginSecondaryRateLimit: true,
      ...retry,
    };
  }

  if (parsePositiveRetryAfterSeconds(meta.retryAfterHeader) != null) {
    return {
      classification: "secondary_rate_limit",
      pluginPrimaryRateLimit: false,
      pluginSecondaryRateLimit: true,
      ...retry,
    };
  }

  if (meta.pluginPrimaryRateLimit) {
    return {
      classification: "rate_limit",
      pluginPrimaryRateLimit: true,
      pluginSecondaryRateLimit: false,
      ...retry,
    };
  }

  if (
    (err.status === 401 || err.status === 403) &&
    BAD_CREDENTIALS_MESSAGE.test(err.message) &&
    now < ctx.expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS
  ) {
    return {
      classification: "probable_secondary",
      pluginPrimaryRateLimit: meta.pluginPrimaryRateLimit,
      pluginSecondaryRateLimit: false,
      ...retry,
    };
  }

  if (err.status === 401 || err.status === 403) {
    return {
      classification: "auth",
      pluginPrimaryRateLimit: meta.pluginPrimaryRateLimit,
      pluginSecondaryRateLimit: false,
      retryAfterSeconds: 0,
      retryAfterSource: "default",
    };
  }

  return {
    classification: "other",
    pluginPrimaryRateLimit: meta.pluginPrimaryRateLimit,
    pluginSecondaryRateLimit: meta.pluginSecondaryRateLimit,
    ...retry,
  };
}

function parsePositiveRetryAfterSeconds(header: string | undefined): number | undefined {
  if (header == null || header === "") return undefined;
  const parsed = Number(header);
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  return undefined;
}

function resolveRetryAfter(
  meta: ReturnType<typeof extractGithubResponseMeta>,
  now: number,
): { retryAfterSeconds: number; retryAfterSource: RetryAfterSource } {
  const fromHeader = parsePositiveRetryAfterSeconds(meta.retryAfterHeader);
  if (fromHeader != null) {
    return { retryAfterSeconds: fromHeader, retryAfterSource: "header" };
  }

  if (meta.rateLimitReset) {
    const resetMs = Number(meta.rateLimitReset) * 1000;
    if (Number.isFinite(resetMs)) {
      const seconds = Math.max(1, Math.ceil((resetMs - now) / 1000) + 1);
      return { retryAfterSeconds: seconds, retryAfterSource: "x-ratelimit-reset" };
    }
  }

  return { retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS, retryAfterSource: "default" };
}

export function isRateLimitClassification(classification: GithubToolErrorClassification): boolean {
  return (
    classification === "rate_limit" ||
    classification === "secondary_rate_limit" ||
    classification === "probable_secondary"
  );
}

export function bumpRateLimitConsecutiveFailures(
  consecutive: number,
  classification: GithubToolErrorClassification,
): number {
  // Preserve streak on token_expired so near-expiry blocks do not erase rate-limit circuit progress
  if (classification === "token_expired") return consecutive;
  return isRateLimitClassification(classification) ? consecutive + 1 : 0;
}

export const TOKEN_EXPIRED_TOOL_MESSAGE =
  "Installation token is near expiry; cannot call GitHub tools for this review run. Call submitReview with your current analysis if possible.";

function logGithubToolRequestErrorPayload(
  payload: Record<string, unknown>,
  classification: GithubToolErrorClassification,
): void {
  const log = isRateLimitClassification(classification) ? logDebug : logWarn;
  log("github_tool_request_error", payload);
}

export function logGithubToolRequestError(
  tool: string,
  err: unknown,
  logCtx: GithubToolLogContext,
  classified: ClassifiedGithubError,
): void {
  const timing = getTokenTiming(logCtx.expiresAtTs, logCtx.now, logCtx.ttlMs);
  const base: Record<string, unknown> = {
    tool,
    classification: classified.classification,
    ...timing,
    owner: logCtx.owner,
    repo: logCtx.repo,
    pr: logCtx.prNumber,
    mode: logCtx.mode,
    pluginPrimaryRateLimit: classified.pluginPrimaryRateLimit,
    pluginSecondaryRateLimit: classified.pluginSecondaryRateLimit,
    retryAfterSeconds: classified.retryAfterSeconds,
    retryAfterSource: classified.retryAfterSource,
  };

  if (isGithubRequestError(err)) {
    const meta = extractGithubResponseMeta(err);
    logGithubToolRequestErrorPayload(
      {
        ...base,
        status: meta.status,
        message: meta.message,
        method: meta.method,
        url: meta.url?.slice(0, 200),
        githubRequestId: meta.githubRequestId,
        rateLimitResource: meta.rateLimitResource,
        rateLimitRemaining: meta.rateLimitRemaining,
        rateLimitLimit: meta.rateLimitLimit,
        rateLimitReset: meta.rateLimitReset,
        rateLimitUsed: meta.rateLimitUsed,
        retryAfterHeader: meta.retryAfterHeader,
        octokitRetryCount: meta.octokitRetryCount,
      },
      classified.classification,
    );
    return;
  }

  if (isGraphqlRateLimitError(err)) {
    logGithubToolRequestErrorPayload(
      {
        ...base,
        status: 0,
        message: err instanceof Error ? err.message.slice(0, MESSAGE_TRUNCATE) : String(err),
      },
      "rate_limit",
    );
    return;
  }

  if (classified.classification === "token_expired") {
    logGithubToolRequestErrorPayload(
      {
        ...base,
        status: 0,
        message:
          err instanceof Error
            ? err.message.slice(0, MESSAGE_TRUNCATE)
            : err == null
              ? "token near expiry guard"
              : typeof err === "string" || typeof err === "number" || typeof err === "boolean"
                ? String(err)
                : "unknown error",
      },
      classified.classification,
    );
    return;
  }

  logGithubToolRequestErrorPayload(
    {
      ...base,
      status: 0,
      message: err instanceof Error ? err.message.slice(0, MESSAGE_TRUNCATE) : String(err),
    },
    classified.classification,
  );
}

export function formatToolErrorMessage(
  tool: string,
  err: unknown,
  classified: ClassifiedGithubError,
): string {
  const base =
    err instanceof Error
      ? `Error executing ${tool}: ${err.message}`
      : `Error executing ${tool}: ${String(err)}`;

  if (classified.classification === "token_expired") {
    return TOKEN_EXPIRED_TOOL_MESSAGE;
  }

  if (!isRateLimitClassification(classified.classification)) {
    return base;
  }

  const seconds = classified.retryAfterSeconds || DEFAULT_COOLDOWN_SECONDS;
  return `${base}\n\nRate-limit cooldown ${seconds}s; do not issue tool calls until cooldown elapses`;
}
