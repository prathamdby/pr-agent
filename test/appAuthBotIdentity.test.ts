import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors/appError.js";
import {
  clearAppBotIdentityCacheForTest,
  clearInstallationOctokitCacheForTest,
  getAppBotIdentity,
  prewarmAppBotIdentity,
  resetCreateAppAuth,
  resetInstallationOctokitFactory,
  setCreateAppAuth,
  setInstallationOctokitFactory,
  type InstallationOctokitClient,
} from "../src/github/appAuth.js";

const authFn = vi.fn(async () => ({ token: "jwt" }));
const getAuthenticated = vi.fn();
const getByUsername = vi.fn();

function fakeOctokit(token: string | undefined): InstallationOctokitClient {
  return {
    rest: {
      apps: { getAuthenticated },
      users: { getByUsername },
    },
    hook: { after: vi.fn() },
    token,
  };
}

const cfg = { githubAppId: "111", githubAppPrivateKey: "k" } as const;

function holdAuthenticatedAppResponse(): () => void {
  let release: () => void = () => {
    throw new Error("getAuthenticated was not called");
  };
  getAuthenticated.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ data: { slug: "pr-agent" } });
      }),
  );
  return () => release();
}

describe("app bot identity cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAppBotIdentityCacheForTest();
    clearInstallationOctokitCacheForTest();
    setCreateAppAuth(() => authFn);
    setInstallationOctokitFactory(fakeOctokit);
    authFn.mockResolvedValue({ token: "jwt" });
    getAuthenticated.mockResolvedValue({ data: { slug: "pr-agent" } });
    getByUsername.mockResolvedValue({ data: { id: 123, login: "pr-agent[bot]" } });
  });

  afterEach(() => {
    resetCreateAppAuth();
    resetInstallationOctokitFactory();
    clearInstallationOctokitCacheForTest();
  });

  it("coalesces concurrent cold app identity lookups", async () => {
    const release = holdAuthenticatedAppResponse();

    const pending = Promise.all([getAppBotIdentity(cfg), getAppBotIdentity(cfg)]);
    await vi.waitFor(() => expect(getAuthenticated).toHaveBeenCalledTimes(1));
    expect(authFn).toHaveBeenCalledTimes(1);

    release();
    const [first, second] = await pending;
    expect(first).toEqual({ userId: 123, login: "pr-agent[bot]" });
    expect(second).toEqual(first);
    expect(getByUsername).toHaveBeenCalledTimes(1);
  });

  it("lets a cold caller await the boot prewarm lookup", async () => {
    const release = holdAuthenticatedAppResponse();

    prewarmAppBotIdentity(cfg);
    await vi.waitFor(() => expect(getAuthenticated).toHaveBeenCalledTimes(1));
    const pending = getAppBotIdentity(cfg);
    expect(authFn).toHaveBeenCalledTimes(1);

    release();
    await expect(pending).resolves.toEqual({ userId: 123, login: "pr-agent[bot]" });
    expect(getByUsername).toHaveBeenCalledTimes(1);
  });

  it("clears a failed pending lookup so the next caller retries", async () => {
    getAuthenticated.mockRejectedValueOnce(new Error("boom"));

    await expect(getAppBotIdentity(cfg)).rejects.toThrow("boom");
    await expect(getAppBotIdentity(cfg)).resolves.toEqual({
      userId: 123,
      login: "pr-agent[bot]",
    });
    expect(authFn).toHaveBeenCalledTimes(2);
    expect(getAuthenticated).toHaveBeenCalledTimes(2);
  });

  it("throws github.missing_app_slug when /app response has no slug", async () => {
    getAuthenticated.mockResolvedValueOnce({ data: {} });

    await expect(getAppBotIdentity(cfg)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) return false;
      expect(error.code).toBe("github.missing_app_slug");
      return true;
    });
  });
});
