import { TOKEN_FRESHNESS_BUFFER_MS } from "../settings/index.js";

export { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../settings/index.js";

export function isInstallationTokenNearExpiry(
  expiresAtTs: number,
  now: number = Date.now(),
): boolean {
  return now >= expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS;
}
