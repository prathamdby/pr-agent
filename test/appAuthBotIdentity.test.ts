import { beforeEach, describe, expect, it, vi } from "vitest";

const authFn = vi.fn();
const getAuthenticated = vi.fn();
const getByUsername = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => authFn),
}));

vi.mock("@octokit/plugin-retry", () => ({
  retry: vi.fn(),
}));

vi.mock("@octokit/plugin-throttling", () => ({
  throttling: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    static plugin() {
      return this;
    }

    readonly rest = {
      apps: { getAuthenticated },
      users: { getByUsername },
    };
  },
}));

import { AppError } from "../src/errors/appError.js";
import {
  clearAppBotIdentityCacheForTest,
  getAppBotIdentity,
  prewarmAppBotIdentity,
} from "../src/github/appAuth.js";

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
    authFn.mockResolvedValue({ token: "jwt" });
    getAuthenticated.mockResolvedValue({ data: { slug: "pr-agent" } });
    getByUsername.mockResolvedValue({ data: { id: 123, login: "pr-agent[bot]" } });
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

    await expect(getAppBotIdentity(cfg)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("github.missing_app_slug");
      return true;
    });
  });
});
