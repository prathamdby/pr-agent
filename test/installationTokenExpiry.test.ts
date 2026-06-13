import { describe, expect, it } from "vitest";
import { isInstallationTokenNearExpiry } from "../src/github/installationTokenExpiry.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";

describe("installationTokenExpiry", () => {
  it("returns true inside the freshness buffer", () => {
    const now = 1_000_000;
    expect(isInstallationTokenNearExpiry(now + TOKEN_FRESHNESS_BUFFER_MS - 1, now)).toBe(true);
  });

  it("returns false when expiry is far away", () => {
    const now = 1_000_000;
    expect(isInstallationTokenNearExpiry(now + 30 * 60 * 1000, now)).toBe(false);
  });
});
