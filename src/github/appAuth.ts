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

/** GitHub login for the authenticated installation (bot user), scoped to `GITHUB_APP_ID`. */
export async function resolveBotIdentity(
	token: string,
	githubAppId: string,
): Promise<{ userId: number; login: string }> {
	const cached = cachedBotUsers.get(githubAppId);
	if (cached) return cached;

	const o = installationOctokit(token);
	const { data } = await o.rest.users.getAuthenticated();
	const u = { userId: data.id, login: data.login };
	cachedBotUsers.set(githubAppId, u);
	log.debug("resolved_bot_identity", { login: u.login, githubAppId });
	return u;
}

export async function getBotUserId(token: string, githubAppId: string): Promise<number> {
	const { userId } = await resolveBotIdentity(token, githubAppId);
	return userId;
}
