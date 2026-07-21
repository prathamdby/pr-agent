import { isInstallationTokenNearExpiry } from "../../github/installationTokenExpiry.js";

/** Live token holder hooks used by V2 GitHub writes (decision 27). */
export type InstallationTokenRefreshHooks = {
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
};

/**
 * Proactively refresh when the live holder is near expiry. No-op when hooks are
 * absent or the token is still fresh. Callers keep reading via `getToken()`.
 */
export async function refreshInstallationTokenIfNearExpiry(
  hooks: InstallationTokenRefreshHooks,
): Promise<void> {
  if (!hooks.refreshInstallationToken || !hooks.getTokenExpiresAtTs) return;
  const expiresAtTs = hooks.getTokenExpiresAtTs();
  if (expiresAtTs == null) return;
  if (!isInstallationTokenNearExpiry(expiresAtTs)) return;
  await hooks.refreshInstallationToken();
}
