import { beforeEach, describe, expect, it } from "vitest";
import {
  clearInstallationOctokitCacheForTest,
  evictInstallationOctokit,
  installationOctokit,
} from "../src/github/appAuth.js";

describe("installationOctokit", () => {
  beforeEach(() => {
    clearInstallationOctokitCacheForTest();
  });

  it("reuses one throttled client per installation token", () => {
    const first = installationOctokit("token-a");
    const second = installationOctokit("token-a");
    const other = installationOctokit("token-b");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("evicts only the requested token client", () => {
    const first = installationOctokit("token-a");
    const other = installationOctokit("token-b");

    evictInstallationOctokit("token-a");

    expect(installationOctokit("token-a")).not.toBe(first);
    expect(installationOctokit("token-b")).toBe(other);
  });
});
