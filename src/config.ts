import { getProviders, type KnownProvider } from "@earendil-works/pi-ai";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required environment variable: ${name}`);
	return v;
}

function optionalEnv(name: string, defaultValue: string): string {
	return process.env[name] ?? defaultValue;
}

export function loadConfig() {
	const port = Number(optionalEnv("PORT", "3000"));
	if (!Number.isFinite(port) || port < 1) throw new Error("PORT must be a positive number");

	const githubAppId = requireEnv("GITHUB_APP_ID");
	const githubAppPrivateKey = requireEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
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
