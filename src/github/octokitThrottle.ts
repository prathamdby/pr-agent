import type { Octokit } from "@octokit/core";
import type { EndpointDefaults } from "@octokit/types";
import { logDebug } from "../evlog.js";

import {
  PRIMARY_RATE_LIMIT_MAX_RETRIES,
  SECONDARY_RATE_LIMIT_MAX_RETRIES,
} from "../settings/index.js";

export function onRateLimit(
  retryAfter: number,
  options: Required<EndpointDefaults>,
  _octokit: Octokit,
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
  options: Required<EndpointDefaults>,
  _octokit: Octokit,
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
