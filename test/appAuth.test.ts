import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstallationOctokitCacheForTest,
  installationOctokit,
} from "../src/github/appAuth.js";

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

  it("evicts expired token clients", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const first = installationOctokit("token-a", Date.now() + 1_000);
    const other = installationOctokit("token-b", Date.now() + 5_000);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(installationOctokit("token-a", Date.now() + 1_000)).not.toBe(first);
    expect(installationOctokit("token-b")).toBe(other);
  });
});
