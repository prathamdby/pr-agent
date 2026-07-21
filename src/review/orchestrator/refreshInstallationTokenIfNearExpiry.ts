import { isInstallationTokenNearExpiry } from "../../github/installationTokenExpiry.js";

/** Live token holder hooks used by V2 GitHub writes (decision 27). */
export type InstallationTokenRefreshHooks = {
  readonly getTokenExpiresAtTs?: () => number | undefined;
  readonly refreshInstallationToken?: () => Promise<{ token: string; expiresAtTs: number }>;
  /**
   * Preferred V2 path: holder-updating near-expiry refresh. When set, this is used instead of
   * composing `getTokenExpiresAtTs` + `refreshInstallationToken`.
   */
  readonly refreshNearExpiry?: () => Promise<void>;
};

/**
 * Proactively refresh when the live holder is near expiry. No-op when hooks are
 * absent or the token is still fresh. Callers keep reading via `getToken()`.
 */
export async function refreshInstallationTokenIfNearExpiry(
  hooks: InstallationTokenRefreshHooks,
): Promise<void> {
  if (hooks.refreshNearExpiry) {
    await hooks.refreshNearExpiry();
    return;
  }
  if (!hooks.refreshInstallationToken || !hooks.getTokenExpiresAtTs) return;
  const expiresAtTs = hooks.getTokenExpiresAtTs();
  if (expiresAtTs == null) return;
  if (!isInstallationTokenNearExpiry(expiresAtTs)) return;
  await hooks.refreshInstallationToken();
}
