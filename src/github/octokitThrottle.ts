import { logDebug } from "../evlog.js";

import { PRIMARY_RATE_LIMIT_MAX_RETRIES, SECONDARY_RATE_LIMIT_MAX_RETRIES } from "../settings.js";

type ThrottleRequestOptions = {
  method: string;
  url: string;
};

export function onRateLimit(
  retryAfter: number,
  options: ThrottleRequestOptions,
  _octokit: unknown,
  retryCount: number,
): boolean {
  const willRetry = retryCount < PRIMARY_RATE_LIMIT_MAX_RETRIES;
  logDebug("octokit_on_rate_limit", {
    method: options.method,
    url: options.url,
    retryAfter,
    retryCount,
    willRetry,
  });
  return willRetry;
}

export function onSecondaryRateLimit(
  retryAfter: number,
  options: ThrottleRequestOptions,
  _octokit: unknown,
  retryCount: number,
): boolean {
  const willRetry = retryAfter > 0 && retryCount < SECONDARY_RATE_LIMIT_MAX_RETRIES;
  logDebug("octokit_on_secondary_rate_limit", {
    method: options.method,
    url: options.url,
    retryAfter,
    retryCount,
    willRetry,
  });
  return willRetry;
}
