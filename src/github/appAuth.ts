import { createAppAuth, type InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import type { Config } from "../config.js";
import { log } from "../log.js";

type CachedInstallation = InstallationAccessTokenAuthentication & { expiresAtTs: number };
const installationTokenCache = new Map<number, CachedInstallation>();

const RetryOctokit = Octokit.plugin(retry);
export type InstallationOctokit = InstanceType<typeof RetryOctokit>;

/** Bot user is keyed by GitHub App id so multiple apps in one process do not collide. */
const cachedBotUsers = new Map<string, { userId: number; login: string }>();

async function mintInstallationAuth(
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
 * Cached installation token (60s freshness buffer before JWT expiry claims).
 */
export async function getInstallationToken(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationId: number,
): Promise<string> {
	const now = Date.now();
	const hit = installationTokenCache.get(installationId);
	if (hit && hit.expiresAtTs - 60_000 > now) {
		return hit.token;
	}

	const auth = await mintInstallationAuth(cfg, installationId);
	const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : now + 55 * 60 * 1000;
	installationTokenCache.set(installationId, {
		...auth,
		expiresAtTs: expiresAt,
	});
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
async function resolveBotIdentityViaAppSlug(cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">): Promise<{ userId: number; login: string }> {
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

/** GitHub login for the authenticated installation (bot user), scoped to `GITHUB_APP_ID`. */
export async function resolveBotIdentity(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationToken: string,
): Promise<{ userId: number; login: string }> {
	const cached = cachedBotUsers.get(cfg.githubAppId);
	if (cached) return cached;

	const o = installationOctokit(installationToken);
	let u: { userId: number; login: string };
	try {
		const { data } = await o.rest.users.getAuthenticated();
		u = { userId: data.id, login: data.login };
	} catch (e: unknown) {
		const status = (e as { status?: number }).status;
		if (status !== 403) throw e;

		log.debug("resolved_bot_identity_fallback_jwt_slug", { githubAppId: cfg.githubAppId });
		u = await resolveBotIdentityViaAppSlug(cfg);
	}

	cachedBotUsers.set(cfg.githubAppId, u);
	log.debug("resolved_bot_identity", { login: u.login, githubAppId: cfg.githubAppId });
	return u;
}

export async function getBotUserId(
	cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
	installationToken: string,
): Promise<number> {
	const { userId } = await resolveBotIdentity(cfg, installationToken);
	return userId;
}
