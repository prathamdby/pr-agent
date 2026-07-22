import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstallationOctokitCacheForTest,
  installationOctokit,
} from "../src/github/appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../src/settings/index.js";

describe("installationOctokit", () => {
  beforeEach(() => {
    clearInstallationOctokitCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses one throttled client per installation token", () => {
    const first = installationOctokit("token-a");
    const second = installationOctokit("token-a");
    const other = installationOctokit("token-b");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("evicts clients at the provided token expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const first = installationOctokit("token-a", Date.now() + 1_000);
    const other = installationOctokit("token-b", Date.now() + 5_000);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(installationOctokit("token-a", Date.now() + 1_000)).not.toBe(first);
    expect(installationOctokit("token-b")).toBe(other);
  });

  it("uses the fallback ttl when expiry is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const first = installationOctokit("token-a");

    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_FALLBACK_TTL_MS - 1);
    expect(installationOctokit("token-a")).toBe(first);

    await vi.advanceTimersByTimeAsync(1);
    expect(installationOctokit("token-a")).not.toBe(first);
  });

  it("tightens fallback entries when a later call provides expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const first = installationOctokit("token-a");
    const second = installationOctokit("token-a", Date.now() + 1_000);

    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(installationOctokit("token-a")).not.toBe(first);
  });
});
