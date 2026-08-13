import {
  createAppAuth as octokitCreateAppAuth,
  type InstallationAccessTokenAuthentication,
} from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { Config } from "../config.js";
import { AppError, nonErrorThrown } from "../errors/appError.js";
import { logDebug } from "../evlog.js";
import { onRateLimit, onSecondaryRateLimit } from "./octokitThrottle.js";
import { noteGithubRequestSuccess } from "./rateLimitCircuit.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../settings/index.js";

const ThrottledOctokit = Octokit.plugin(retry, throttling);
export type InstallationOctokit = InstanceType<typeof ThrottledOctokit>;

export type OctokitReactionParams = {
  readonly owner?: string;
  readonly repo?: string;
  readonly issue_number?: number;
  readonly comment_id?: number;
  readonly content?: string;
  readonly reaction_id?: number;
  readonly per_page?: number;
};

export type OctokitReactionRow = {
  readonly id: number;
  readonly content: string;
  readonly user: { readonly id: number } | null;
};

export type OctokitReactionPage = {
  readonly data: readonly OctokitReactionRow[];
};

export type InstallationOctokitClient = {
  readonly rest: {
    readonly reactions?: {
      createForIssue(params: OctokitReactionParams): Promise<void>;
      listForIssue(params: OctokitReactionParams): Promise<OctokitReactionPage>;
      deleteForIssue(params: OctokitReactionParams): Promise<void>;
      createForIssueComment(params: OctokitReactionParams): Promise<void>;
      listForIssueComment(params: OctokitReactionParams): Promise<OctokitReactionPage>;
      deleteForIssueComment(params: OctokitReactionParams): Promise<void>;
      createForPullRequestReviewComment(params: OctokitReactionParams): Promise<void>;
      listForPullRequestReviewComment(params: OctokitReactionParams): Promise<OctokitReactionPage>;
      deleteForPullRequestComment(params: OctokitReactionParams): Promise<void>;
    };
    readonly pulls?: {
      get?(params: {
        readonly owner: string;
        readonly repo: string;
        readonly pull_number: number;
      }): Promise<{
        readonly data: {
          readonly base?: { readonly sha?: string; readonly ref?: string };
          readonly head?: { readonly sha?: string | null } | null;
          readonly additions?: number;
          readonly deletions?: number;
          readonly changed_files?: number;
        };
      }>;
      listFiles?(params: {
        readonly owner: string;
        readonly repo: string;
        readonly pull_number: number;
        readonly per_page?: number;
        readonly page?: number;
      }): Promise<{ readonly data: readonly { readonly filename?: string }[] }>;
    };
    readonly issues?: {
      listComments?(params: {
        readonly owner: string;
        readonly repo: string;
        readonly issue_number: number;
        readonly since?: string;
        readonly per_page?: number;
        readonly page?: number;
      }): Promise<{
        readonly data: readonly {
          readonly id: number;
          readonly body?: string;
          readonly html_url?: string;
        }[];
      }>;
      createComment?(params: {
        readonly owner: string;
        readonly repo: string;
        readonly issue_number: number;
        readonly body: string;
      }): Promise<{
        readonly data: {
          readonly id: number;
          readonly body?: string;
          readonly html_url?: string;
        };
      }>;
      updateComment?(params: {
        readonly owner: string;
        readonly repo: string;
        readonly comment_id: number;
        readonly body: string;
      }): Promise<{ readonly data: { readonly id?: number } }>;
    };
    readonly apps?: {
      getAuthenticated?(): Promise<{
        readonly data: { readonly slug?: string } | null;
      }>;
    };
    readonly users?: {
      getByUsername?(params: { readonly username: string }): Promise<{
        readonly data: { readonly id: number; readonly login: string } | null;
      }>;
    };
  };
  readonly hook: {
    after(event: string, listener: () => void): void;
  };
  readonly graphql?: InstallationOctokit["graphql"];
  paginate?(
    fn: (params: OctokitReactionParams) => Promise<OctokitReactionPage>,
    params: OctokitReactionParams,
  ): Promise<readonly OctokitReactionRow[]>;
  readonly token?: string;
};

export type InstallationOctokitFactory = {
  bivarianceHack(token: string | undefined): InstallationOctokit | InstallationOctokitClient;
}["bivarianceHack"];

export type CreateAppAuth = {
  bivarianceHack(options: {
    readonly appId: string | number;
    readonly privateKey: string;
  }): (auth: {
    readonly type: "app" | "installation";
    readonly installationId?: number;
  }) => Promise<{ readonly token: string }>;
}["bivarianceHack"];

const octokitThrottle = { onRateLimit, onSecondaryRateLimit };

const defaultInstallationOctokitFactory: InstallationOctokitFactory = (token) => {
  if (token === undefined) {
    return new ThrottledOctokit({ throttle: octokitThrottle });
  }
  return new ThrottledOctokit({ auth: token, throttle: octokitThrottle });
};

let installationOctokitFactory: InstallationOctokitFactory = defaultInstallationOctokitFactory;

export function setInstallationOctokitFactory(factory: InstallationOctokitFactory): void {
  installationOctokitFactory = factory;
}

export function resetInstallationOctokitFactory(): void {
  installationOctokitFactory = defaultInstallationOctokitFactory;
}

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

let createAppAuthFn: typeof octokitCreateAppAuth = octokitCreateAppAuth;

export function setCreateAppAuth(create: CreateAppAuth): void {
  // SAFETY: tests inject a strategy that returns { token } for type:"app"; production uses createAppAuth.
  createAppAuthFn = create as typeof octokitCreateAppAuth;
}

export function resetCreateAppAuth(): void {
  createAppAuthFn = octokitCreateAppAuth;
}

export async function mintInstallationAuth(
  cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
  installationId: number,
): Promise<InstallationAccessTokenAuthentication> {
  const auth = createAppAuthFn({
    appId: cfg.githubAppId,
    privateKey: cfg.githubAppPrivateKey,
  });
  return auth({
    type: "installation",
    installationId,
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (timer instanceof Object && "unref" in timer) {
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

function bindInstallationOctokit(
  client: InstallationOctokit | InstallationOctokitClient,
): InstallationOctokit {
  client.hook.after("request", () => {
    noteGithubRequestSuccess();
  });
  // SAFETY: production factory returns ThrottledOctokit; tests inject rest stubs for the path under test.
  return client as InstallationOctokit;
}

export function installationOctokit(
  token: string | undefined,
  expiresAtTs?: number,
): InstallationOctokit {
  const now = Date.now();
  if (token === undefined) {
    return bindInstallationOctokit(installationOctokitFactory(undefined));
  }
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

  const octokit = bindInstallationOctokit(installationOctokitFactory(token));
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
  const authFn = createAppAuthFn({
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
  void getAppBotIdentity(cfg).catch((error) => {
    const err =
      error instanceof Error ? error : nonErrorThrown("github.app_bot_identity_prewarm_failed");
    logDebug("app_bot_identity_prewarm_failed", {
      githubAppId: cfg.githubAppId,
      message: err.message,
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
  const jwtOctokit = installationOctokit(jwtToken);
  const { data } = await jwtOctokit.rest.apps.getAuthenticated();
  if (!data?.slug) {
    throw new AppError({
      code: "github.missing_app_slug",
      message: "GitHub App /app response missing slug (cannot resolve bot user)",
    });
  }
  const slug = data.slug;
  const anon = installationOctokit(undefined);
  const { data: user } = await anon.rest.users.getByUsername({
    username: `${slug}[bot]`,
  });
  return { userId: user.id, login: user.login };
}
