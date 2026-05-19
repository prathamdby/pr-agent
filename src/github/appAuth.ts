import { createAppAuth, type InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { Config } from "../config.js";
import { logInfo, logWarn, logError, logDebug } from "../evlog.js";
import { onRateLimit, onSecondaryRateLimit } from "./octokitThrottle.js";

// @ts-expect-error — nested @octokit/core versions between rest, retry, and throttling plugins
const ThrottledOctokit = Octokit.plugin(retry, throttling);
export type InstallationOctokit = InstanceType<typeof ThrottledOctokit>;

export type CachedInstallationToken = InstallationAccessTokenAuthentication & { expiresAtTs: number };
export type BotIdentity = { userId: number; login: string };

export type InstallationToken = {
	readonly token: string;
	readonly expiresAtTs: number;
	/** Observed TTL at mint (ms); used for token_age_seconds in logs */
	readonly ttlMs: number;
};

export async function mintInstallationAuth(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationId: number,
): Promise<InstallationAccessTokenAuthentication> {
	const auth = createAppAuth({
		appId: cfg.githubAppId,
		privateKey: cfg.githubAppPrivateKey,
	});
	return auth({
		type: "installation",
		installationId,
	});
}

export function installationOctokit(token: string): InstallationOctokit {
	return new ThrottledOctokit({
		auth: token,
		throttle: { onRateLimit, onSecondaryRateLimit },
	});
}

async function mintAppJwtToken(cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">): Promise<string> {
	const authFn = createAppAuth({
		appId: cfg.githubAppId,
		privateKey: cfg.githubAppPrivateKey,
	});
	const appAuth = await authFn({ type: "app" });
	return appAuth.token;
}

/**
 * When `GET /user` rejects installation tokens (“Resource not accessible by integration”), resolve bot id via JWT + public {@link https://api.github.com/users/{slug}%5Bbot%5D} profile.
 */
const appBotIdentityByAppId = new Map<string, BotIdentity>();

/** Resolve the app's bot user id without minting an installation token. */
export async function getAppBotIdentity(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
): Promise<BotIdentity> {
	const cached = appBotIdentityByAppId.get(cfg.githubAppId);
	if (cached) return cached;
	const identity = await resolveBotIdentityViaAppSlug(cfg);
	appBotIdentityByAppId.set(cfg.githubAppId, identity);
	return identity;
}

async function resolveBotIdentityViaAppSlug(cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">): Promise<BotIdentity> {
	const jwtToken = await mintAppJwtToken(cfg);
	const jwtOctokit = new ThrottledOctokit({
		auth: jwtToken,
		throttle: { onRateLimit, onSecondaryRateLimit },
	});
	const { data } = await jwtOctokit.rest.apps.getAuthenticated();
	if (!data?.slug) {
		throw new Error("GitHub App /app response missing slug (cannot resolve bot user)");
	}
	const slug = data.slug;
	const anon = new ThrottledOctokit({
		throttle: { onRateLimit, onSecondaryRateLimit },
	});
	const { data: user } = await anon.rest.users.getByUsername({
		username: `${slug}[bot]`,
	});
	return { userId: user.id, login: user.login };
}

/**
 * Mint bot identity for the authenticated installation, with the public-slug fallback.
 * Caching is the caller's responsibility — production callers should go through the
 * `BotIdentity` Effect service.
 */
export async function mintBotIdentity(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationToken: string,
): Promise<BotIdentity> {
	const o = installationOctokit(installationToken);
	let u: BotIdentity;
	try {
		const { data } = await o.rest.users.getAuthenticated();
		u = { userId: data.id, login: data.login };
	} catch (e: unknown) {
		const status = (e as { status?: number }).status;
		if (status !== 403) throw e;

		logDebug("resolved_bot_identity_fallback_jwt_slug", { githubAppId: cfg.githubAppId });
		u = await resolveBotIdentityViaAppSlug(cfg);
	}

	logDebug("resolved_bot_identity", { login: u.login, githubAppId: cfg.githubAppId });
	return u;
}
