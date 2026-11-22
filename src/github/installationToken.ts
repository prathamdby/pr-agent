import {
  type Config,
  INSTALLATION_TOKEN_FALLBACK_TTL_MS,
  TOKEN_FRESHNESS_BUFFER_MS,
} from "../settings/index.ts";
import {
  mintScopedInstallationAuth,
  type InstallationToken,
  type InstallationTokenOptions,
} from "./appAuth.ts";

export type { InstallationToken };

export async function mintInstallationToken(
  cfg: Pick<Config, "github">,
  installationId: number,
  options: InstallationTokenOptions,
) {
  const auth = await mintScopedInstallationAuth(cfg, installationId, options);
  const parsed = Date.parse(auth.expires_at);
  const now = Date.now();
  const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
  return ((pinnedReturn: InstallationToken | Promise<InstallationToken>) => pinnedReturn)({
    token: auth.token,
    expiresAtTs,
    ttlMs: Math.max(0, expiresAtTs - now),
    permissions: auth.permissions,
    repositories: options.repositories,
    repositorySelection: auth.repository_selection,
  });
}

export function isInstallationTokenNearExpiry(expiresAtTs: number, now: number = Date.now()) {
  return ((pinnedReturn: boolean) => pinnedReturn)(now >= expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS);
}
