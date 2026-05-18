import { RequestError } from "@octokit/request-error";
import type { ResponseHeaders } from "@octokit/types";
import { log } from "../log.js";

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

export function isGraphqlRateLimitError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.message === "GraphQL Rate Limit Exceeded") return true;
	const response = (err as { response?: { data?: { errors?: Array<{ type?: string }> } } }).response;
	return (response?.data?.errors ?? []).some((e) => e.type === "RATE_LIMITED");
}

function headerString(headers: ResponseHeaders | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const v = headers[name as keyof ResponseHeaders];
	if (v === undefined || v === null) return undefined;
	return String(v);
}

// GitHub does not return issued-at; age assumes a 1h TTL and may overstate real age when TTL is shorter (e.g. 10m)
const ASSUMED_INSTALLATION_TOKEN_TTL_MS = 60 * 60 * 1000;

export function getTokenTiming(
	expiresAtTs: number,
	now: number = Date.now(),
): { tokenAgeSeconds: number; tokenExpiresInSeconds: number } {
	const tokenExpiresInSeconds = Math.max(0, Math.floor((expiresAtTs - now) / 1000));
	const issuedAtTs = expiresAtTs - ASSUMED_INSTALLATION_TOKEN_TTL_MS;
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

function isPrimaryRateLimitExceeded(message: string, headers: ResponseHeaders | undefined): boolean {
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

	if (meta.retryAfterHeader) {
		const parsed = Number(meta.retryAfterHeader);
		if (Number.isFinite(parsed) && parsed > 0) {
			return {
				classification: "secondary_rate_limit",
				pluginPrimaryRateLimit: false,
				pluginSecondaryRateLimit: true,
				...retry,
			};
		}
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

function resolveRetryAfter(
	meta: ReturnType<typeof extractGithubResponseMeta>,
	now: number,
): { retryAfterSeconds: number; retryAfterSource: RetryAfterSource } {
	if (meta.retryAfterHeader) {
		const parsed = Number(meta.retryAfterHeader);
		if (Number.isFinite(parsed) && parsed > 0) {
			return { retryAfterSeconds: Math.ceil(parsed), retryAfterSource: "header" };
		}
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

export function isRateLimitClassification(
	classification: GithubToolErrorClassification,
): boolean {
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
	if (classification === "token_expired") return consecutive;
	return isRateLimitClassification(classification) ? consecutive + 1 : 0;
}

export const TOKEN_EXPIRED_TOOL_MESSAGE =
	"Installation token is near expiry; cannot call GitHub tools for this review run. Call submitReview with your current analysis if possible.";

export function logGithubToolRequestError(
	tool: string,
	err: unknown,
	logCtx: GithubToolLogContext,
	classified: ClassifiedGithubError,
): void {
	const timing = getTokenTiming(logCtx.expiresAtTs, logCtx.now);
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
		log.warn("github_tool_request_error", {
			...base,
			status: meta.status,
			message: meta.message,
			method: meta.method,
			url: meta.url,
			githubRequestId: meta.githubRequestId,
			rateLimitResource: meta.rateLimitResource,
			rateLimitRemaining: meta.rateLimitRemaining,
			rateLimitLimit: meta.rateLimitLimit,
			rateLimitReset: meta.rateLimitReset,
			rateLimitUsed: meta.rateLimitUsed,
			retryAfterHeader: meta.retryAfterHeader,
			octokitRetryCount: meta.octokitRetryCount,
		});
		return;
	}

	if (isGraphqlRateLimitError(err)) {
		log.warn("github_tool_request_error", {
			...base,
			status: 0,
			message: err instanceof Error ? err.message.slice(0, MESSAGE_TRUNCATE) : String(err),
		});
		return;
	}

	if (classified.classification === "token_expired") {
		log.warn("github_tool_request_error", {
			...base,
			status: 0,
			message:
				err instanceof Error
					? err.message.slice(0, MESSAGE_TRUNCATE)
					: err == null
						? "token near expiry guard"
						: String(err),
		});
		return;
	}

	log.warn("tool_execute_failed", {
		tool,
		message: err instanceof Error ? err.message.slice(0, MESSAGE_TRUNCATE) : String(err),
	});
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
