import type { Octokit } from "@octokit/core";
import type { EndpointDefaults } from "@octokit/types";
import { log } from "../log.js";

export const PRIMARY_RATE_LIMIT_MAX_RETRIES = 2;

export function onRateLimit(
	retryAfter: number,
	options: Required<EndpointDefaults>,
	_octokit: Octokit,
	retryCount: number,
): boolean {
	const willRetry = retryCount < PRIMARY_RATE_LIMIT_MAX_RETRIES;
	log.warn("octokit_on_rate_limit", {
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
	const willRetry = retryAfter > 0 && retryCount === 0;
	log.warn("octokit_on_secondary_rate_limit", {
		method: options.method,
		url: options.url,
		retryAfter,
		retryCount,
		willRetry,
	});
	return willRetry;
}
