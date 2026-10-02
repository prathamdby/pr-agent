import {
  type Config,
  INSTALLATION_TOKEN_FALLBACK_TTL_MS,
  TOKEN_FRESHNESS_BUFFER_MS,
} from "../settings/index.js";
import { mintInstallationAuth, type InstallationToken } from "./appAuth.js";

export type { InstallationToken };

export async function mintInstallationToken(
  cfg: Pick<Config, "github">,
  installationId: number,
): Promise<InstallationToken> {
  const auth = await mintInstallationAuth(cfg, installationId);
  const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
  const now = Date.now();
  const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
  return {
    token: auth.token,
    expiresAtTs,
    ttlMs: Math.max(0, expiresAtTs - now),
  };
}

export function isInstallationTokenNearExpiry(
  expiresAtTs: number,
  now: number = Date.now(),
): boolean {
  return now >= expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS;
}
