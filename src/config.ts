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

	const logLevel = optionalEnv("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error";
	if (!["debug", "info", "warn", "error"].includes(logLevel)) {
		throw new Error('LOG_LEVEL must be one of debug, info, warn, error');
	}

	return {
		port,
		githubAppId,
		githubAppPrivateKey,
		webhookSecret,
		piProvider,
		piModel,
		maxToolRounds,
		maxFinalizeRounds,
		logLevel,
	};
}

export type Config = ReturnType<typeof loadConfig>;
