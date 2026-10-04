import {
  type Config,
  INSTALLATION_TOKEN_FALLBACK_TTL_MS,
  TOKEN_FRESHNESS_BUFFER_MS,
} from "../settings/index.js";
import {
  mintInstallationAuth,
  mintScopedInstallationAuth,
  type InstallationToken,
  type InstallationTokenOptions,
} from "./appAuth.js";

export type { InstallationToken };

export async function mintInstallationToken(
  cfg: Pick<Config, "github">,
  installationId: number,
  options?: InstallationTokenOptions,
): Promise<InstallationToken> {
  if (options) {
    const auth = await mintScopedInstallationAuth(cfg, installationId, options);
    const now = Date.now();
    const parsed = Date.parse(auth.expires_at);
    const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
    return {
      token: auth.token,
      expiresAtTs,
      ttlMs: Math.max(0, expiresAtTs - now),
      permissions: auth.permissions,
      repositories: auth.repositories?.map((repository) => repository.name) ?? options.repositories,
      repositorySelection: auth.repository_selection,
    };
  }
  const auth = await mintInstallationAuth(cfg, installationId);
  const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
  const now = Date.now();
  const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
  return {
    token: auth.token,
    expiresAtTs,
    ttlMs: Math.max(0, expiresAtTs - now),
    permissions: auth.permissions,
  };
}

export function isInstallationTokenNearExpiry(
  expiresAtTs: number,
  now: number = Date.now(),
): boolean {
  return now >= expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS;
}
