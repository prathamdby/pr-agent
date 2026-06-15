import { createAppAuth, type InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { Config } from "../config.js";
import { logDebug } from "../evlog.js";
import { onRateLimit, onSecondaryRateLimit } from "./octokitThrottle.js";
import { httpStatus } from "./httpStatus.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "./installationTokenExpiry.js";

const ThrottledOctokit = Octokit.plugin(retry, throttling);
export type InstallationOctokit = InstanceType<typeof ThrottledOctokit>;
type CachedInstallationOctokit = {
  readonly octokit: InstallationOctokit;
  expiresAtTs: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const installationOctokitByToken = new Map<string, CachedInstallationOctokit>();

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

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

function clearInstallationOctokitEntry(entry: CachedInstallationOctokit): void {
  if (!entry.evictionTimer) return;
  clearTimeout(entry.evictionTimer);
  entry.evictionTimer = null;
}

function scheduleInstallationOctokitEviction(
  token: string,
  entry: CachedInstallationOctokit,
): void {
  clearInstallationOctokitEntry(entry);
  const delayMs = Math.max(0, Math.min(entry.expiresAtTs - Date.now(), MAX_TIMER_DELAY_MS));
  const timer = setTimeout(() => {
    const current = installationOctokitByToken.get(token);
    if (current !== entry || current.expiresAtTs > Date.now()) return;
    installationOctokitByToken.delete(token);
  }, delayMs);
  entry.evictionTimer = timer;
  unrefTimer(timer);
}

export function installationOctokit(token: string, expiresAtTs?: number): InstallationOctokit {
  const now = Date.now();
  const cached = installationOctokitByToken.get(token);
  if (cached) {
    if (cached.expiresAtTs <= now) {
      clearInstallationOctokitEntry(cached);
      installationOctokitByToken.delete(token);
    } else {
      if (expiresAtTs != null && expiresAtTs !== cached.expiresAtTs) {
        cached.expiresAtTs = expiresAtTs;
        scheduleInstallationOctokitEviction(token, cached);
      }
      return cached.octokit;
    }
  }

  const octokit = new ThrottledOctokit({
    auth: token,
    throttle: { onRateLimit, onSecondaryRateLimit } as never,
  });
  const entry = {
    octokit,
    expiresAtTs: expiresAtTs ?? now + INSTALLATION_TOKEN_FALLBACK_TTL_MS,
    evictionTimer: null,
  };
  installationOctokitByToken.set(token, entry);
  scheduleInstallationOctokitEviction(token, entry);
  return octokit;
}

export function clearInstallationOctokitCacheForTest(): void {
  if (process.env.NODE_ENV === "test") {
    for (const entry of installationOctokitByToken.values()) {
      clearInstallationOctokitEntry(entry);
    }
    installationOctokitByToken.clear();
  }
}

async function mintAppJwtToken(
  cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
): Promise<string> {
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
const appBotIdentityByAppId = new Map<string, BotIdentity | Promise<BotIdentity>>();

export function clearAppBotIdentityCacheForTest(): void {
  if (process.env.NODE_ENV === "test") {
    appBotIdentityByAppId.clear();
  }
}

export function prewarmAppBotIdentity(
  cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
): void {
  void getAppBotIdentity(cfg).catch((error: unknown) => {
    logDebug("app_bot_identity_prewarm_failed", {
      githubAppId: cfg.githubAppId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Resolve the app's bot user id without minting an installation token. */
export async function getAppBotIdentity(
  cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
): Promise<BotIdentity> {
  const cached = appBotIdentityByAppId.get(cfg.githubAppId);
  if (cached) return cached;

  const pending = resolveBotIdentityViaAppSlug(cfg);
  appBotIdentityByAppId.set(cfg.githubAppId, pending);
  try {
    const identity = await pending;
    appBotIdentityByAppId.set(cfg.githubAppId, identity);
    return identity;
  } catch (error) {
    if (appBotIdentityByAppId.get(cfg.githubAppId) === pending) {
      appBotIdentityByAppId.delete(cfg.githubAppId);
    }
    throw error;
  }
}

async function resolveBotIdentityViaAppSlug(
  cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
): Promise<BotIdentity> {
  const jwtToken = await mintAppJwtToken(cfg);
  const jwtOctokit = new ThrottledOctokit({
    auth: jwtToken,
    throttle: { onRateLimit, onSecondaryRateLimit } as never,
  });
  const { data } = await jwtOctokit.rest.apps.getAuthenticated();
  if (!data?.slug) {
    throw new Error("GitHub App /app response missing slug (cannot resolve bot user)");
  }
  const slug = data.slug;
  const anon = new ThrottledOctokit({
    throttle: { onRateLimit, onSecondaryRateLimit } as never,
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
    const status = httpStatus(e);
    if (status !== 403) throw e;

    logDebug("resolved_bot_identity_fallback_jwt_slug", {
      githubAppId: cfg.githubAppId,
    });
    u = await resolveBotIdentityViaAppSlug(cfg);
  }

  logDebug("resolved_bot_identity", {
    login: u.login,
    githubAppId: cfg.githubAppId,
  });
  return u;
}
