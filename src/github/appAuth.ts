import { createAppAuth, type InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import type { Config } from "../config.js";
import { log } from "../log.js";

const RetryOctokit = Octokit.plugin(retry);
export type InstallationOctokit = InstanceType<typeof RetryOctokit>;

export type CachedInstallationToken = InstallationAccessTokenAuthentication & { expiresAtTs: number };
export type BotIdentity = { userId: number; login: string };

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

/**
 * Mint an installation token without caching. Production callers should go through
 * the {@link GithubInstallationToken} Effect service, which adds a Ref-backed
 * cache with a 60s freshness buffer.
 */
export async function getInstallationToken(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationId: number,
): Promise<string> {
	const auth = await mintInstallationAuth(cfg, installationId);
	log.debug("minted_installation_token", { installationId, expiresAt: auth.expiresAt });
	return auth.token;
}

export function installationOctokit(token: string): InstallationOctokit {
	return new RetryOctokit({ auth: token });
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
async function resolveBotIdentityViaAppSlug(cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">): Promise<BotIdentity> {
	const jwtToken = await mintAppJwtToken(cfg);
	const jwtOctokit = new RetryOctokit({ auth: jwtToken });
	const { data } = await jwtOctokit.rest.apps.getAuthenticated();
	if (!data?.slug) {
		throw new Error("GitHub App /app response missing slug (cannot resolve bot user)");
	}
	const slug = data.slug;
	const anon = new RetryOctokit();
	const { data: user } = await anon.rest.users.getByUsername({
		username: `${slug}[bot]`,
	});
	return { userId: user.id, login: user.login };
}

/**
 * Mint bot identity for the authenticated installation, with the public-slug fallback.
 * Caching is the caller's responsibility — production callers should go through the
 * {@link BotIdentity} Effect service.
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

		log.debug("resolved_bot_identity_fallback_jwt_slug", { githubAppId: cfg.githubAppId });
		u = await resolveBotIdentityViaAppSlug(cfg);
	}

	log.debug("resolved_bot_identity", { login: u.login, githubAppId: cfg.githubAppId });
	return u;
}

/** @deprecated Use the {@link BotIdentity} Effect service for cached lookups. */
export async function resolveBotIdentity(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationToken: string,
): Promise<BotIdentity> {
	return mintBotIdentity(cfg, installationToken);
}

export async function getBotUserId(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationToken: string,
): Promise<number> {
	const { userId } = await mintBotIdentity(cfg, installationToken);
	return userId;
}
