import type { Config } from "../config.js";
import { mintInstallationAuth, type InstallationToken } from "./appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../settings/index.js";
import { isInstallationTokenNearExpiry } from "./installationTokenExpiry.js";

export type { InstallationToken };

const installationTokenCache = new Map<number, InstallationToken | Promise<InstallationToken>>();

export function clearInstallationTokenCacheForTest(): void {
  if (process.env.NODE_ENV === "test") {
    installationTokenCache.clear();
  }
}

export async function mintInstallationToken(
  cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
  installationId: number,
): Promise<InstallationToken> {
  const cached = installationTokenCache.get(installationId);
  if (cached) {
    const token = await cached;
    if (!isInstallationTokenNearExpiry(token.expiresAtTs)) return token;
  }

  const pending = (async () => {
    const auth = await mintInstallationAuth(cfg, installationId);
    const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
    const now = Date.now();
    const expiresAtTs = Number.isFinite(parsed) ? parsed : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
    return {
      token: auth.token,
      expiresAtTs,
      ttlMs: Math.max(0, expiresAtTs - now),
    };
  })();
  installationTokenCache.set(installationId, pending);
  try {
    const token = await pending;
    installationTokenCache.set(installationId, token);
    return token;
  } catch (error) {
    installationTokenCache.delete(installationId);
    throw error;
  }
}
