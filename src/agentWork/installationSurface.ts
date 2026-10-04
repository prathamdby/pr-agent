import { createHash } from "node:crypto";
import type { Config } from "../settings/index.js";
import {
  getAppBotIdentity,
  lookupRepositoryInstallation,
  parseRepositoryInstallation,
  type BotIdentity,
  type InstallationToken,
} from "../github/appAuth.js";
import {
  mintInstallationToken,
  isInstallationTokenNearExpiry,
} from "../github/installationToken.js";
import { createPrSurface } from "../github/prSurface.js";
import {
  installationCapabilitiesFromPermissions,
  deniedInstallationCapabilities,
  unknownInstallationCapabilities,
  parseInstallationPermissions,
  type InstallationCapabilities,
  type InstallationPermissions,
} from "../github/installationCapabilities.js";
import { AppError } from "../errors/appError.js";

type AppConfig = Pick<Config, "github">;

export type InstallationSurfaceDependencies = {
  readonly mintToken: typeof mintInstallationToken;
  readonly resolveBot: typeof getAppBotIdentity;
  readonly surface: typeof createPrSurface;
  readonly now: () => number;
  readonly lookupInstallation?: typeof lookupRepositoryInstallation;
};
export type InstallationPreflightParams = {
  readonly cfg: AppConfig;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly signal?: AbortSignal;
  readonly generation?: string;
};
export type InstallationPreflightResult = {
  readonly observation: InstallationCapabilities;
  readonly installation?: InstallationToken;
};

const identityKey = (cfg: AppConfig) =>
  createHash("sha256")
    .update(JSON.stringify([cfg.github.appId, cfg.github.privateKey]))
    .digest("hex");
const repositoryKey = (params: InstallationPreflightParams) =>
  `${identityKey(params.cfg)}:${params.installationId}:${params.owner.toLowerCase()}/${params.repo.toLowerCase()}`;
const permissionKey = (permissions: InstallationPermissions) =>
  JSON.stringify(Object.entries(permissions).toSorted(([a], [b]) => a.localeCompare(b)));
type ScopedTokenEntry = {
  readonly permissionsKey: string;
  readonly pending: Promise<InstallationToken>;
  value?: InstallationToken;
};
type PendingPreflight = {
  readonly pending: Promise<InstallationPreflightResult>;
  readonly controller: AbortController;
  waiters: number;
  cancelled: boolean;
};
function preflightUnavailable(cause?: unknown): AppError {
  return new AppError({
    domain: "github",
    kind: "preflight_unavailable",
    message: "GitHub repository installation could not be confirmed within its deadline",
    cause,
  });
}

/** One adapter owns credentials, concurrent cold lookups, and freshness policy. */
export function openInstallationSurface(
  dependencies: InstallationSurfaceDependencies = {
    mintToken: (cfg, id, options) => mintInstallationToken(cfg, id, options),
    resolveBot: (cfg) => getAppBotIdentity(cfg),
    surface: (params) => createPrSurface(params),
    now: Date.now,
  },
) {
  const tokens = new Map<string, Promise<InstallationToken>>();
  const bots = new Map<string, Promise<BotIdentity>>();
  const preflights = new Map<string, PendingPreflight>();
  let lastGeneration = 0;
  const scopedTokens = new Map<string, ScopedTokenEntry>();
  function usableScopedToken(params: InstallationPreflightParams): InstallationToken | undefined {
    const value = scopedTokens.get(repositoryKey(params))?.value;
    return value && value.expiresAtTs > dependencies.now() ? value : undefined;
  }

  async function scopedToken(
    params: InstallationPreflightParams,
    permissions?: InstallationPermissions,
    seed?: InstallationToken,
  ): Promise<InstallationToken> {
    const key = repositoryKey(params);
    const cached = scopedTokens.get(key);
    const permissionsKey = permissions
      ? permissionKey(permissions)
      : (cached?.permissionsKey ?? "");
    const previous = cached ? await cached.pending : seed;
    params.signal?.throwIfAborted();
    const consistent =
      !permissions ||
      (previous?.permissions != null &&
        Object.entries(permissions).every(
          ([permission, grant]) => previous.permissions?.[permission] === grant,
        ));
    if (
      previous &&
      cached?.permissionsKey === permissionsKey &&
      consistent &&
      !isInstallationTokenNearExpiry(previous.expiresAtTs, dependencies.now())
    )
      return previous;
    if (cached && scopedTokens.get(key) !== cached) return scopedToken(params, permissions, seed);
    const repositories = previous?.repositories ? [...previous.repositories] : [params.repo];
    const discardAborted = () => {
      if (scopedTokens.get(key)?.pending !== pending) return;
      if (cached?.value) scopedTokens.set(key, cached);
      else scopedTokens.delete(key);
    };
    const pending = dependencies
      .mintToken(params.cfg, params.installationId, {
        signal: params.signal,
        repositories,
      })
      .then((value) => {
        params.signal?.throwIfAborted();
        const effective =
          value.permissions === undefined
            ? undefined
            : parseInstallationPermissions(value.permissions);
        if (value.permissions !== undefined && !effective) throw preflightUnavailable();
        if (
          value.repositorySelection === "all" ||
          (value.repositories &&
            (!value.repositories.includes(params.repo) ||
              value.repositories.some((repository) => !repositories.includes(repository))))
        ) {
          throw preflightUnavailable();
        }
        const current = scopedTokens.get(key);
        if (current?.pending === pending) current.value = value;
        return value;
      })
      .catch((error: unknown) => {
        discardAborted();
        throw error;
      })
      .finally(() => params.signal?.removeEventListener("abort", discardAborted));
    scopedTokens.set(key, { pending, permissionsKey, value: cached?.value });
    params.signal?.addEventListener("abort", discardAborted, { once: true });
    return pending;
  }

  function preflight(params: InstallationPreflightParams): Promise<InstallationPreflightResult> {
    params.signal?.throwIfAborted();
    const key = repositoryKey(params);
    const joined = preflights.get(key);
    if (joined)
      return joinPreflight(joined, params.signal, () => {
        if (preflights.get(key) === joined) preflights.delete(key);
      });
    const controller = new AbortController();
    lastGeneration = Math.max(dependencies.now(), lastGeneration + 1);
    const generation = params.generation ?? String(lastGeneration);
    const scope = {
      appId: params.cfg.github.appId,
      installationId: params.installationId,
      owner: params.owner,
      repo: params.repo,
    };
    const timer = setTimeout(() => controller.abort(preflightUnavailable()), 2_000);
    let rejectAborted: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const abort = () => rejectAborted(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    const observe = async (): Promise<InstallationPreflightResult> => {
      const raw = await (dependencies.lookupInstallation ?? lookupRepositoryInstallation)(
        params.cfg,
        params.owner,
        params.repo,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const metadata = parseRepositoryInstallation(raw);
      if (!metadata) throw preflightUnavailable();
      if (
        String(metadata.app_id) !== params.cfg.github.appId ||
        metadata.id !== params.installationId ||
        metadata.suspended_at != null
      ) {
        return { observation: deniedInstallationCapabilities(scope, generation) };
      }
      const observed = installationCapabilitiesFromPermissions({
        scope,
        generation,
        permissions: metadata.permissions,
      });
      if (
        observed.availability.pullRequestsRead === "denied" ||
        observed.availability.contentsRead === "denied"
      )
        return { observation: observed };
      const installation = await scopedToken(
        { ...params, signal: controller.signal },
        metadata.permissions,
      );
      controller.signal.throwIfAborted();
      const effective = { ...metadata.permissions };
      if (installation.permissions) {
        for (const permission of Object.keys(effective)) {
          const grant = installation.permissions[permission];
          if (!grant) delete effective[permission];
          else if (grant === "read") effective[permission] = "read";
        }
      }
      const observation = installationCapabilitiesFromPermissions({
        scope,
        generation,
        permissions: effective,
      });
      return { observation, installation };
    };
    let entry: PendingPreflight;
    const pending = Promise.race([observe(), aborted])
      .catch((error: unknown) => {
        if (entry.cancelled) throw error;
        const installation = usableScopedToken(params);
        if (!installation) throw preflightUnavailable(error);
        return { observation: unknownInstallationCapabilities(scope, generation), installation };
      })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        if (preflights.get(key) === entry) preflights.delete(key);
      });
    entry = { pending, controller, waiters: 0, cancelled: false };
    preflights.set(key, entry);
    return joinPreflight(entry, params.signal, () => {
      if (preflights.get(key) === entry) preflights.delete(key);
    });
  }

  function botIdentity(cfg: AppConfig): Promise<BotIdentity> {
    const key = identityKey(cfg);
    const cached = bots.get(key);
    if (cached) return cached;
    const pending = dependencies.resolveBot(cfg).catch((error: unknown) => {
      if (bots.get(key) === pending) bots.delete(key);
      throw error;
    });
    bots.set(key, pending);
    return pending;
  }

  async function token(cfg: AppConfig, installationId: number): Promise<InstallationToken> {
    const key = `${identityKey(cfg)}:${installationId}`;
    const cached = tokens.get(key);
    if (cached) {
      const value = await cached;
      if (!isInstallationTokenNearExpiry(value.expiresAtTs, dependencies.now())) return value;
      // Another waiter may already have replaced the expired promise.
      if (tokens.get(key) !== cached) return token(cfg, installationId);
    }
    const pending = dependencies.mintToken(cfg, installationId).catch((error: unknown) => {
      if (tokens.get(key) === pending) tokens.delete(key);
      throw error;
    });
    tokens.set(key, pending);
    return pending;
  }

  async function create(
    params: Omit<Parameters<typeof createPrSurface>[0], "installation"> & {
      readonly installation?: InstallationToken;
    },
  ) {
    const unknownAccess =
      params.capabilities?.observation.availability.pullRequestsRead === "unknown" &&
      params.capabilities.observation.availability.contentsRead === "unknown";
    const recoverableToken = () => {
      const usable = usableScopedToken(params) ?? params.installation;
      if (!usable || usable.expiresAtTs <= dependencies.now()) throw preflightUnavailable();
      return usable;
    };
    const installation =
      params.installation ??
      (unknownAccess
        ? recoverableToken()
        : params.capabilities
          ? await scopedToken(params, params.capabilities.observation.permissions)
          : await token(params.cfg, params.installationId));
    let seed = installation;
    return dependencies.surface({
      ...params,
      installation,
      tokenResolver:
        params.tokenResolver ??
        (unknownAccess
          ? async () => recoverableToken()
          : params.capabilities
            ? () => scopedToken(params, undefined, installation)
            : async () => {
                if (seed && !isInstallationTokenNearExpiry(seed.expiresAtTs, dependencies.now())) {
                  return seed;
                }
                seed = await token(params.cfg, params.installationId);
                return seed;
              }),
    });
  }

  return { botIdentity, token, create, preflight };
}

function joinPreflight(
  entry: PendingPreflight,
  signal: AbortSignal | undefined,
  remove: () => void,
): Promise<InstallationPreflightResult> {
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      entry.waiters--;
      signal?.removeEventListener("abort", abort);
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      reject(signal?.reason);
      if (entry.waiters === 0) {
        entry.cancelled = true;
        remove();
        entry.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    entry.pending.then(
      (result) => {
        if (finish()) resolve(result);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
  });
}

export type InstallationSurface = ReturnType<typeof openInstallationSurface>;

export const productionInstallationSurface = openInstallationSurface();
