import type { InstallationTokenHandle } from "../../src/github/installationTokenHandle.js";

/** Mutable test token handle; optional refreshNearExpiry spy. */
export function testTokenHandle(
  overrides: {
    token?: string;
    expiresAtTs?: number;
    refreshNearExpiry?: () => Promise<void>;
  } = {},
): InstallationTokenHandle & { token: string; expiresAtTs: number } {
  const handle = {
    token: overrides.token ?? "tok",
    expiresAtTs: overrides.expiresAtTs ?? Date.now() + 3_600_000,
    getToken: () => handle.token,
    getExpiresAtTs: () => handle.expiresAtTs,
    refreshNearExpiry:
      overrides.refreshNearExpiry ??
      (async () => {
        /* no-op */
      }),
  };
  return handle;
}
