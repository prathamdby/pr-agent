import { createHash } from "node:crypto";
import type { Config } from "../settings/index.js";
import { getAppBotIdentity, type BotIdentity, type InstallationToken } from "../github/appAuth.js";
import {
  mintInstallationToken,
  isInstallationTokenNearExpiry,
} from "../github/installationToken.js";
import { createPrSurface } from "../github/prSurface.js";

type AppConfig = Pick<Config, "github">;

export type InstallationSurfaceDependencies = {
  readonly mintToken: typeof mintInstallationToken;
  readonly resolveBot: typeof getAppBotIdentity;
  readonly surface: typeof createPrSurface;
  readonly now: () => number;
};

const identityKey = (cfg: AppConfig) =>
  createHash("sha256")
    .update(JSON.stringify([cfg.github.appId, cfg.github.privateKey]))
    .digest("hex");

/** One adapter owns credentials, concurrent cold lookups, and freshness policy. */
export function openInstallationSurface(
  dependencies: InstallationSurfaceDependencies = {
    mintToken: (cfg, id) => mintInstallationToken(cfg, id),
    resolveBot: (cfg) => getAppBotIdentity(cfg),
    surface: (params) => createPrSurface(params),
    now: Date.now,
  },
) {
  const tokens = new Map<string, Promise<InstallationToken>>();
  const bots = new Map<string, Promise<BotIdentity>>();

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
    const installation = params.installation ?? (await token(params.cfg, params.installationId));
    return dependencies.surface({ ...params, installation });
  }

  return { botIdentity, token, create };
}

export type InstallationSurface = ReturnType<typeof openInstallationSurface>;

export const productionInstallationSurface = openInstallationSurface();
