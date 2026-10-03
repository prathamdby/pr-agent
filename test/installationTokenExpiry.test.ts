import { describe, expect, it } from "vitest";
import { isInstallationTokenNearExpiry } from "../src/github/installationToken.js";
import { TOKEN_FRESHNESS_BUFFER_MS } from "../src/settings/index.js";
import {
  installationCapabilitiesFromPermissions,
  createReviewCapabilityPolicy,
  essentialCapabilitiesDenied,
} from "../src/github/installationCapabilities.js";

describe("installationTokenExpiry", () => {
  it("requires reads and review writes but not contents write, with endpoint permission alternatives", () => {
    const observation = installationCapabilitiesFromPermissions({
      scope: { appId: 1, installationId: 2, owner: "o", repo: "r" },
      generation: "fresh",
      permissions: { contents: "read", pull_requests: "write" },
    });
    expect(essentialCapabilitiesDenied(observation)).toEqual([]);
    expect(observation.availability.commentsWrite).toBe("available");
    expect(observation.availability.labelsWrite).toBe("available");
    expect(observation.availability.checksRead).toBe("denied");
  });

  it("shrinks only the denied operation for the lifetime of a run", async () => {
    const observation = installationCapabilitiesFromPermissions({
      scope: { appId: 1, installationId: 2, owner: "o", repo: "r" },
      generation: "fresh",
      permissions: { checks: "write" },
    });
    const policy = createReviewCapabilityPolicy(observation);
    await policy.deny("checksWrite");
    expect(policy.access("checksWrite")).toBe("denied");
    expect(policy.access("checksRead")).toBe("available");
    expect(observation.availability.checksWrite).toBe("available");
  });

  it("returns true inside the freshness buffer", () => {
    const now = 1_000_000;
    expect(isInstallationTokenNearExpiry(now + TOKEN_FRESHNESS_BUFFER_MS - 1, now)).toBe(true);
  });

  it("returns false when expiry is far away", () => {
    const now = 1_000_000;
    expect(isInstallationTokenNearExpiry(now + 30 * 60 * 1000, now)).toBe(false);
  });
});
