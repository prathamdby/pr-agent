import crypto from "node:crypto";
import { getProviders, type KnownProvider } from "@earendil-works/pi-ai";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required environment variable: ${name}`);
	return v;
}

function optionalEnv(name: string, defaultValue: string): string {
	return process.env[name] ?? defaultValue;
}

function stripMatchingQuotes(value: string): string {
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
		return value.slice(1, -1);
	}
	return value;
}

function looksLikePemPrivateKey(value: string): boolean {
	return value.includes("-----BEGIN ") && value.includes("PRIVATE KEY-----");
}

function decodeBase64Pem(value: string): string | null {
	const compact = value.replace(/\s/g, "");
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
		return null;
	}

	const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
	return looksLikePemPrivateKey(decoded) ? decoded : null;
}

export function normalizeGithubAppPrivateKey(raw: string): string {
	const unquoted = stripMatchingQuotes(raw.trim());
	let key = unquoted.replace(/\\n/g, "\n");

	if (!looksLikePemPrivateKey(key)) {
		const decoded = decodeBase64Pem(unquoted);
		if (decoded) key = decoded.replace(/\\n/g, "\n");
	}

	try {
		crypto.createPrivateKey(key);
	} catch {
		throw new Error(
			"GITHUB_APP_PRIVATE_KEY must be a valid unencrypted PEM private key. Use the GitHub App private key content with real newlines, escaped \\n newlines, or base64-encoded PEM.",
		);
	}

	return key;
}

export function loadConfig() {
	const port = Number(optionalEnv("PORT", "3000"));
	if (!Number.isFinite(port) || port < 1) throw new Error("PORT must be a positive number");

	const githubAppId = requireEnv("GITHUB_APP_ID");
	const githubAppPrivateKey = normalizeGithubAppPrivateKey(requireEnv("GITHUB_APP_PRIVATE_KEY"));
	const webhookSecret = requireEnv("WEBHOOK_SECRET");
	const databaseUrl = requireEnv("DATABASE_URL");

	const roleRaw = optionalEnv("ROLE", "web");
	if (!["web", "worker"].includes(roleRaw)) {
		throw new Error('ROLE must be one of web, worker');
	}
	const role = roleRaw as "web" | "worker";

	const piProviderRaw = optionalEnv("PI_PROVIDER", "openai");
	const piModel = optionalEnv("PI_MODEL", "gpt-4o-mini");
	const providers = getProviders() as readonly string[];
	if (!providers.includes(piProviderRaw)) {
		throw new Error(
			`PI_PROVIDER "${piProviderRaw}" is unknown. Pick one of: ${providers.slice(0, 12).join(", ")}…`,
		);
	}
	const piProvider = piProviderRaw as KnownProvider;

	const maxToolRounds = Number(optionalEnv("MAX_TOOL_ROUNDS", "24"));
	if (!Number.isFinite(maxToolRounds) || maxToolRounds < 1) {
		throw new Error("MAX_TOOL_ROUNDS must be a positive number");
	}

	const maxFinalizeRounds = Number(optionalEnv("MAX_FINALIZE_ROUNDS", "6"));
	if (!Number.isFinite(maxFinalizeRounds) || maxFinalizeRounds < 0) {
		throw new Error("MAX_FINALIZE_ROUNDS must be zero or a positive number");
	}

	const maxReviewPublishAttempts = Number(optionalEnv("MAX_REVIEW_PUBLISH_ATTEMPTS", "3"));
	if (!Number.isFinite(maxReviewPublishAttempts) || maxReviewPublishAttempts < 1) {
		throw new Error("MAX_REVIEW_PUBLISH_ATTEMPTS must be a positive number");
	}

	const reviewConcurrency = Number(optionalEnv("REVIEW_CONCURRENCY", "2"));
	if (!Number.isFinite(reviewConcurrency) || reviewConcurrency < 1) {
		throw new Error("REVIEW_CONCURRENCY must be a positive number");
	}

	const askConcurrency = Number(optionalEnv("ASK_CONCURRENCY", "1"));
	if (!Number.isFinite(askConcurrency) || askConcurrency < 1) {
		throw new Error("ASK_CONCURRENCY must be a positive number");
	}

	const ackConcurrency = Number(optionalEnv("ACK_CONCURRENCY", "2"));
	if (!Number.isFinite(ackConcurrency) || ackConcurrency < 1) {
		throw new Error("ACK_CONCURRENCY must be a positive number");
	}

	const queueRetryLimit = Number(optionalEnv("QUEUE_RETRY_LIMIT", "3"));
	if (!Number.isFinite(queueRetryLimit) || queueRetryLimit < 0) {
		throw new Error("QUEUE_RETRY_LIMIT must be zero or a positive number");
	}

	const queueRetryDelaySeconds = Number(optionalEnv("QUEUE_RETRY_DELAY_SECONDS", "30"));
	if (!Number.isFinite(queueRetryDelaySeconds) || queueRetryDelaySeconds < 0) {
		throw new Error("QUEUE_RETRY_DELAY_SECONDS must be zero or a positive number");
	}

	const queueRetryDelayMaxSeconds = Number(optionalEnv("QUEUE_RETRY_DELAY_MAX_SECONDS", "300"));
	if (!Number.isFinite(queueRetryDelayMaxSeconds) || queueRetryDelayMaxSeconds < 1) {
		throw new Error("QUEUE_RETRY_DELAY_MAX_SECONDS must be a positive number");
	}

	const queueExpireInSeconds = Number(optionalEnv("QUEUE_EXPIRE_IN_SECONDS", "3600"));
	if (!Number.isFinite(queueExpireInSeconds) || queueExpireInSeconds < 1) {
		throw new Error("QUEUE_EXPIRE_IN_SECONDS must be a positive number");
	}

	const queueHeartbeatSeconds = Number(optionalEnv("QUEUE_HEARTBEAT_SECONDS", "60"));
	if (!Number.isFinite(queueHeartbeatSeconds) || queueHeartbeatSeconds < 10) {
		throw new Error("QUEUE_HEARTBEAT_SECONDS must be at least 10");
	}

	const queueRetentionSeconds = Number(optionalEnv("QUEUE_RETENTION_SECONDS", "1209600"));
	if (!Number.isFinite(queueRetentionSeconds) || queueRetentionSeconds < 1) {
		throw new Error("QUEUE_RETENTION_SECONDS must be a positive number");
	}

	const queueDeleteAfterSeconds = Number(optionalEnv("QUEUE_DELETE_AFTER_SECONDS", "604800"));
	if (!Number.isFinite(queueDeleteAfterSeconds) || queueDeleteAfterSeconds < 0) {
		throw new Error("QUEUE_DELETE_AFTER_SECONDS must be zero or a positive number");
	}

	const installationGroupConcurrency = Number(optionalEnv("INSTALLATION_GROUP_CONCURRENCY", "2"));
	if (!Number.isFinite(installationGroupConcurrency) || installationGroupConcurrency < 1) {
		throw new Error("INSTALLATION_GROUP_CONCURRENCY must be a positive number");
	}

	const maxAskToolRounds = Number(optionalEnv("MAX_ASK_TOOL_ROUNDS", "12"));
	if (!Number.isFinite(maxAskToolRounds) || maxAskToolRounds < 1) {
		throw new Error("MAX_ASK_TOOL_ROUNDS must be a positive number");
	}

	const webhookTimeoutMs = Number(optionalEnv("WEBHOOK_TIMEOUT_MS", "10000"));
	if (!Number.isFinite(webhookTimeoutMs) || webhookTimeoutMs < 1) {
		throw new Error("WEBHOOK_TIMEOUT_MS must be a positive number");
	}

	const context7ApiKey = optionalEnv("CONTEXT7_API_KEY", "");

	const maxReviewFindings = Number(optionalEnv("MAX_REVIEW_FINDINGS", "8"));
	if (!Number.isFinite(maxReviewFindings) || maxReviewFindings < 1) {
		throw new Error("MAX_REVIEW_FINDINGS must be a positive number");
	}

	const enableReviewLabelsEffort = optionalEnv("ENABLE_REVIEW_LABELS_EFFORT", "true") === "true";
	const enableReviewLabelsSecurity = optionalEnv("ENABLE_REVIEW_LABELS_SECURITY", "false") === "true";

	const maxPrFilesListed = Number(optionalEnv("MAX_PR_FILES_LISTED", "300"));
	if (!Number.isFinite(maxPrFilesListed) || maxPrFilesListed < 1) {
		throw new Error("MAX_PR_FILES_LISTED must be a positive number");
	}

	const maxPrFilesPatchBytes = Number(optionalEnv("MAX_PR_FILES_PATCH_BYTES", "500000"));
	if (!Number.isFinite(maxPrFilesPatchBytes) || maxPrFilesPatchBytes < 1) {
		throw new Error("MAX_PR_FILES_PATCH_BYTES must be a positive number");
	}

	const logLevel = optionalEnv("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error";
	if (!["debug", "info", "warn", "error"].includes(logLevel)) {
		throw new Error('LOG_LEVEL must be one of debug, info, warn, error');
	}

	const logMaxWideEvents = Number(optionalEnv("LOG_MAX_WIDE_EVENTS", "128"));
	if (!Number.isFinite(logMaxWideEvents) || logMaxWideEvents < 1) {
		throw new Error("LOG_MAX_WIDE_EVENTS must be a positive number");
	}

	const logPrettyDefault = process.env.NODE_ENV === "production" ? "false" : "true";
	const logPretty = optionalEnv("LOG_PRETTY", logPrettyDefault) === "true";

	return {
		port,
		githubAppId,
		githubAppPrivateKey,
		webhookSecret,
		databaseUrl,
		role,
		piProvider,
		piModel,
		maxToolRounds,
		maxFinalizeRounds,
		maxReviewPublishAttempts,
		reviewConcurrency,
		askConcurrency,
		ackConcurrency,
		queueRetryLimit,
		queueRetryDelaySeconds,
		queueRetryDelayMaxSeconds,
		queueExpireInSeconds,
		queueHeartbeatSeconds,
		queueRetentionSeconds,
		queueDeleteAfterSeconds,
		installationGroupConcurrency,
		maxAskToolRounds,
		webhookTimeoutMs,
		context7ApiKey,
		maxReviewFindings,
		enableReviewLabelsEffort,
		enableReviewLabelsSecurity,
		maxPrFilesListed,
		maxPrFilesPatchBytes,
		logLevel,
		logMaxWideEvents,
		logPretty,
	};
}

export type Config = ReturnType<typeof loadConfig>;
