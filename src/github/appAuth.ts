import { createHash } from "node:crypto";
import { createAppAuth, type InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { type Config, INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../settings/index.js";
import { AppError } from "../errors/appError.js";
import { logDebug } from "../evlog.js";
import { onRateLimit, onSecondaryRateLimit } from "./octokitThrottle.js";
import { noteGithubRequestSuccess } from "./rateLimitCircuit.js";
import { errorMessage } from "../errors/errorMessage.js";
import {
  parseInstallationPermissions,
  type InstallationPermissions,
} from "./installationCapabilities.js";

const ThrottledOctokit = Octokit.plugin(retry, throttling);
export type InstallationOctokit = InstanceType<typeof ThrottledOctokit>;
type CachedInstallationOctokit = {
  readonly octokit: InstallationOctokit;
  expiresAtTs: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type BotIdentity = { userId: number; login: string };

export type InstallationToken = {
  readonly token: string;
  readonly expiresAtTs: number;
  /** Observed TTL at mint (ms); used for token_age_seconds in logs */
  readonly ttlMs: number;
  readonly permissions?: InstallationPermissions;
  readonly repositories?: readonly string[];
  readonly requestedPermissions?: InstallationTokenOptions["permissions"];
  readonly repositorySelection?: "all" | "selected";
};

export type InstallationTokenOptions = {
  readonly signal?: AbortSignal;
  readonly repositories?: string[];
  readonly permissions?: NonNullable<
    Parameters<Octokit["rest"]["apps"]["createInstallationAccessToken"]>[0]
  >["permissions"];
};
export type RepositoryInstallation = {
  readonly id: number;
  readonly app_id: number | string;
  readonly suspended_at: string | null;
  readonly permissions: InstallationPermissions;
  readonly repository_selection: "all" | "selected";
};

export function parseRepositoryInstallation(value: unknown): RepositoryInstallation | undefined {
  if (
    typeof value !== "object" ||
    value == null ||
    Array.isArray(value) ||
    !("id" in value) ||
    !("app_id" in value) ||
    !("suspended_at" in value) ||
    !("permissions" in value) ||
    !("repository_selection" in value)
  )
    return undefined;
  if (
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    (typeof value.app_id !== "number" && typeof value.app_id !== "string") ||
    !Number.isSafeInteger(Number(value.app_id)) ||
    Number(value.app_id) <= 0 ||
    (value.suspended_at !== null &&
      (typeof value.suspended_at !== "string" ||
        !Number.isFinite(Date.parse(value.suspended_at)))) ||
    (value.repository_selection !== "all" && value.repository_selection !== "selected")
  )
    return undefined;
  const permissions = parseInstallationPermissions(value.permissions);
  if (!permissions) return undefined;
  return {
    id: value.id,
    app_id: value.app_id,
    suspended_at: value.suspended_at,
    repository_selection: value.repository_selection,
    permissions,
  };
}

/** App JWT transport deliberately has neither throttling nor retry plugins. */
export async function lookupRepositoryInstallation(
  cfg: Pick<Config, "github">,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const jwt = await mintAppJwtToken(cfg);
  signal?.throwIfAborted();
  const octokit = new Octokit({ auth: jwt });
  const { data } = await octokit.rest.apps.getRepoInstallation({
    owner,
    repo,
    request: { signal },
  });
  return data;
}

export async function mintScopedInstallationAuth(
  cfg: Pick<Config, "github">,
  installationId: number,
  options: InstallationTokenOptions,
) {
  const jwt = await mintAppJwtToken(cfg);
  options.signal?.throwIfAborted();
  const octokit = new Octokit({ auth: jwt });
  const { data } = await octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    repositories: options.repositories,
    permissions: options.permissions,
    request: { signal: options.signal },
  });
  if (
    !parseInstallationPermissions(data.permissions) ||
    (data.repository_selection !== "all" && data.repository_selection !== "selected") ||
    (options.repositories &&
      (data.repository_selection !== "selected" ||
        data.repositories?.some((repository) => !options.repositories?.includes(repository.name))))
  ) {
    throw new AppError({
      domain: "github",
      kind: "preflight_unavailable",
      message: "GitHub installation token returned invalid permissions or repository scope",
    });
  }
  return data;
}

export async function mintInstallationAuth(
  cfg: Pick<Config, "github">,
  installationId: number,
): Promise<InstallationAccessTokenAuthentication> {
  const auth = createAppAuth({
    appId: cfg.github.appId,
    privateKey: cfg.github.privateKey,
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

export function createInstallationOctokitCache() {
  const installationOctokitByToken = new Map<string, CachedInstallationOctokit>();
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

  function installationOctokit(token: string, expiresAtTs?: number): InstallationOctokit {
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
      throttle: { onRateLimit, onSecondaryRateLimit },
    });
    octokit.hook.after("request", () => {
      noteGithubRequestSuccess();
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

  return installationOctokit;
}

export const installationOctokit = createInstallationOctokitCache();

async function mintAppJwtToken(cfg: Pick<Config, "github">): Promise<string> {
  const authFn = createAppAuth({
    appId: cfg.github.appId,
    privateKey: cfg.github.privateKey,
  });
  const appAuth = await authFn({ type: "app" });
  return appAuth.token;
}

/**
 * When `GET /user` rejects installation tokens (“Resource not accessible by integration”), resolve bot id via JWT + public {@link https://api.github.com/users/{slug}%5Bbot%5D} profile.
 */
export function prewarmAppBotIdentity(cfg: Pick<Config, "github">): void {
  void getAppBotIdentity(cfg).catch((error: unknown) => {
    logDebug("app_bot_identity_prewarm_failed", {
      githubAppId: cfg.github.appId,
      message: errorMessage(error),
    });
  });
}

/** Resolve the app's bot user id without minting an installation token. */
export function createAppBotIdentityLookup() {
  const appBotIdentityByAppId = new Map<string, BotIdentity | Promise<BotIdentity>>();
  async function getAppBotIdentity(cfg: Pick<Config, "github">): Promise<BotIdentity> {
    const identityKey = createHash("sha256")
      .update(JSON.stringify([cfg.github.appId, cfg.github.privateKey]))
      .digest("hex");
    const cached = appBotIdentityByAppId.get(identityKey);
    if (cached) return cached;

    const pending = resolveBotIdentityViaAppSlug(cfg);
    appBotIdentityByAppId.set(identityKey, pending);
    try {
      const identity = await pending;
      appBotIdentityByAppId.set(identityKey, identity);
      return identity;
    } catch (error) {
      if (appBotIdentityByAppId.get(identityKey) === pending) {
        appBotIdentityByAppId.delete(identityKey);
      }
      throw error;
    }
  }

  return getAppBotIdentity;
}

export const getAppBotIdentity = createAppBotIdentityLookup();

async function resolveBotIdentityViaAppSlug(cfg: Pick<Config, "github">): Promise<BotIdentity> {
  const jwtToken = await mintAppJwtToken(cfg);
  const jwtOctokit = new ThrottledOctokit({
    auth: jwtToken,
    throttle: { onRateLimit, onSecondaryRateLimit },
  });
  const { data } = await jwtOctokit.rest.apps.getAuthenticated();
  if (!data?.slug) {
    throw new AppError({
      domain: "github",
      kind: "missing_app_slug",
      message: "GitHub App /app response missing slug (cannot resolve bot user)",
    });
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
