import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstallationOctokitCache } from "../src/github/appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../src/settings/index.js";
import { openInstallationSurface } from "../src/agentWork/installationSurface.js";
import { makeTestConfig } from "./helpers/config.js";

let installationOctokit = createInstallationOctokitCache();

describe("installationOctokit", () => {
  it("refreshes cached scoped credentials whose permission metadata is missing", async () => {
    const cfg = makeTestConfig();
    const permissions = { contents: "read", pull_requests: "write" };
    const token = {
      token: "fresh",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
      repositories: ["r"],
    };
    const mintToken = vi
      .fn()
      .mockResolvedValueOnce(token)
      .mockResolvedValue({ ...token, permissions });
    const adapter = openInstallationSurface({
      lookupInstallation: vi.fn(async () => ({
        id: 42,
        app_id: cfg.github.appId,
        suspended_at: null,
        repository_selection: "selected",
        permissions,
      })),
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    await adapter.preflight(params);
    await adapter.preflight(params);
    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(mintToken).toHaveBeenLastCalledWith(
      cfg,
      42,
      expect.objectContaining({ repositories: ["r"], signal: expect.any(AbortSignal) }),
    );
  });

  it("deduplicates only concurrent repository observations and refreshes changed grants", async () => {
    const cfg = makeTestConfig();
    const lookupInstallation = vi.fn(async () => ({
      id: 42,
      app_id: cfg.github.appId,
      suspended_at: null,
      repository_selection: "selected",
      permissions: { contents: "read", pull_requests: "write", checks: "write" },
    }));
    const mintToken = vi.fn(async () => ({
      token: "fresh",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
      permissions: { contents: "read", pull_requests: "write", checks: "write" },
      repositories: ["r"],
    }));
    const adapter = openInstallationSurface({
      lookupInstallation,
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    const [first, joined] = await Promise.all([
      adapter.preflight(params),
      adapter.preflight(params),
    ]);
    expect(joined.observation.generation).toBe(first.observation.generation);
    expect(lookupInstallation).toHaveBeenCalledTimes(1);
    await adapter.preflight(params);
    expect(lookupInstallation).toHaveBeenCalledTimes(2);
    expect(mintToken).toHaveBeenCalledTimes(1);
    lookupInstallation.mockResolvedValueOnce({
      id: 42,
      app_id: cfg.github.appId,
      suspended_at: null,
      repository_selection: "selected",
      permissions: { contents: "read", pull_requests: "write", checks: "read" },
    });
    await adapter.preflight(params);
    expect(mintToken).toHaveBeenCalledTimes(2);
  });

  it("aborts transport when the shared metadata and token deadline expires", async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const adapter = openInstallationSurface({
      lookupInstallation: async (_cfg, _owner, _repo, signal) => {
        transportSignal = signal;
        return new Promise(() => {});
      },
      mintToken: vi.fn(),
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const pending = adapter.preflight({
      cfg: makeTestConfig(),
      installationId: 42,
      owner: "o",
      repo: "r",
    });
    const failure = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await failure).toMatchObject({ code: "github.preflight_unavailable" });
    expect(transportSignal?.aborted).toBe(true);
  });

  it("mints receipt-ready scoped auth when publication is denied but reads remain available", async () => {
    const cfg = makeTestConfig();
    const mintToken = vi.fn(async () => ({
      token: "receipt-auth",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
      permissions: { contents: "read", pull_requests: "read" },
      repositories: ["r"],
    }));
    const adapter = openInstallationSurface({
      lookupInstallation: async () => ({
        id: 42,
        app_id: cfg.github.appId,
        suspended_at: null,
        repository_selection: "all",
        permissions: { contents: "read", pull_requests: "read" },
      }),
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const result = await adapter.preflight({
      cfg,
      installationId: 42,
      owner: "o",
      repo: "r",
      generation: "9001",
    });
    expect(result.installation?.token).toBe("receipt-auth");
    expect(result.observation.generation).toBe("9001");
    expect(result.observation.availability).toMatchObject({
      pullRequestsRead: "available",
      contentsRead: "available",
      reviewWrite: "denied",
      commentsWrite: "denied",
    });
    expect(mintToken).toHaveBeenCalledWith(
      cfg,
      42,
      expect.objectContaining({ repositories: ["r"] }),
    );
  });

  it("bounds cold mint and metadata by the same deadline", async () => {
    vi.useFakeTimers();
    const cfg = makeTestConfig();
    let mintSignal: AbortSignal | undefined;
    const adapter = openInstallationSurface({
      lookupInstallation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return {
          id: 42,
          app_id: cfg.github.appId,
          suspended_at: null,
          repository_selection: "selected",
          permissions: { contents: "read", pull_requests: "read" },
        };
      },
      mintToken: async (_cfg, _id, options) => {
        mintSignal = options?.signal;
        return new Promise(() => {});
      },
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const failure = adapter
      .preflight({
        cfg,
        installationId: 42,
        owner: "o",
        repo: "r",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await failure).toMatchObject({ code: "github.preflight_unavailable" });
    expect(mintSignal?.aborted).toBe(true);
  });

  it.each([
    { status: 404, message: "Not Found" },
    { status: 429, message: "API rate limit exceeded" },
    { status: 503, message: "Service unavailable" },
    { status: 403, message: "Resource not accessible by integration" },
  ])(
    "retains usable scoped auth with unknown access after metadata failure $status",
    async ({ status, message }) => {
      const cfg = makeTestConfig();
      const lookupInstallation = vi.fn(async (): Promise<unknown> => ({
        id: 42,
        app_id: cfg.github.appId,
        suspended_at: null,
        repository_selection: "selected",
        permissions: { contents: "read", pull_requests: "write" },
      }));
      const mintToken = vi.fn(async () => ({
        token: "cached",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
        repositories: ["r"],
      }));
      const adapter = openInstallationSurface({
        lookupInstallation,
        mintToken,
        resolveBot: vi.fn(),
        surface: vi.fn(),
        now: Date.now,
      });
      const params = { cfg, installationId: 42, owner: "o", repo: "r" };
      await adapter.preflight(params);
      lookupInstallation.mockRejectedValueOnce(Object.assign(new Error(message), { status }));
      const result = await adapter.preflight(params);
      expect(result.installation?.token).toBe("cached");
      expect(new Set(Object.values(result.observation.availability))).toEqual(new Set(["unknown"]));
      expect(mintToken).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    { permissions: null },
    { permissions: [] },
    { permissions: { contents: "owner", pull_requests: "write" } },
    { permissions: { contents: "read", pull_requests: 7 } },
    { repository_selection: "unexpected" },
  ])("does not turn malformed metadata into denial or mint auth: %j", async (invalid) => {
    const cfg = makeTestConfig();
    const lookupInstallation = vi.fn(async (): Promise<unknown> => ({
      id: 42,
      app_id: cfg.github.appId,
      suspended_at: null,
      repository_selection: "selected",
      permissions: { contents: "read", pull_requests: "write" },
    }));
    const mintToken = vi.fn(async () => ({
      token: "cached",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
      repositories: ["r"],
    }));
    const adapter = openInstallationSurface({
      lookupInstallation,
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    await adapter.preflight(params);
    lookupInstallation.mockResolvedValueOnce(
      invalid == null
        ? invalid
        : {
            id: 42,
            app_id: cfg.github.appId,
            suspended_at: null,
            repository_selection: "selected",
            permissions: { contents: "read", pull_requests: "write" },
            ...invalid,
          },
    );
    const result = await adapter.preflight(params);
    expect(result.observation.availability.reviewWrite).toBe("unknown");
    expect(result.installation?.token).toBe("cached");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("cannot mint unbounded auth after unknown metadata without a scoped cache", async () => {
    const mintToken = vi.fn();
    const adapter = openInstallationSurface({
      lookupInstallation: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    await expect(
      adapter.preflight({
        cfg: makeTestConfig(),
        installationId: 42,
        owner: "o",
        repo: "r",
      }),
    ).rejects.toMatchObject({ code: "github.preflight_unavailable" });
    expect(mintToken).not.toHaveBeenCalled();
  });

  it("uses a still-valid near-expiry cached token for unknown-access managed reads without refreshing", async () => {
    const cfg = makeTestConfig();
    const lookupInstallation = vi.fn(async (): Promise<unknown> => ({
      id: 42,
      app_id: cfg.github.appId,
      suspended_at: null,
      repository_selection: "selected",
      permissions: { contents: "read", pull_requests: "write" },
    }));
    const mintToken = vi.fn(async () => ({
      token: "cached",
      expiresAtTs: Date.now() + 10_000,
      ttlMs: 10_000,
      repositories: ["r"],
    }));
    const surface = vi.fn();
    const adapter = openInstallationSurface({
      lookupInstallation,
      mintToken,
      resolveBot: vi.fn(),
      surface,
      now: Date.now,
    });
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    await adapter.preflight(params);
    lookupInstallation.mockResolvedValueOnce(null);
    const result = await adapter.preflight(params);
    const { createReviewCapabilityPolicy } =
      await import("../src/github/installationCapabilities.js");
    await adapter.create({
      ...params,
      prNumber: 5,
      installation: result.installation,
      capabilities: createReviewCapabilityPolicy(result.observation),
    });
    const resolver = surface.mock.calls[0]?.[0]?.tokenResolver;
    expect((await resolver()).token).toBe("cached");
    expect(mintToken).toHaveBeenCalledTimes(1);
  });

  it("does not widen an explicitly selected repository on refresh", async () => {
    const cfg = makeTestConfig();
    const lookupInstallation = vi.fn(async () => ({
      id: 42,
      app_id: cfg.github.appId,
      suspended_at: null,
      repository_selection: "all",
      permissions: { contents: "read", pull_requests: "read" },
    }));
    const mintToken = vi
      .fn()
      .mockResolvedValueOnce({
        token: "narrow",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
        permissions: { contents: "read", pull_requests: "read" },
        repositories: ["r"],
      })
      .mockResolvedValue({
        token: "narrow-refreshed",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
        permissions: { contents: "read", pull_requests: "read" },
        repositories: ["r"],
      });
    const adapter = openInstallationSurface({
      lookupInstallation,
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    await adapter.preflight(params);
    lookupInstallation.mockResolvedValueOnce({
      id: 42,
      app_id: cfg.github.appId,
      suspended_at: null,
      repository_selection: "all",
      permissions: { contents: "read", pull_requests: "write" },
    });
    const result = await adapter.preflight(params);
    expect(mintToken).toHaveBeenLastCalledWith(
      cfg,
      42,
      expect.objectContaining({ repositories: ["r"] }),
    );
    expect(result.observation.availability.reviewWrite).toBe("denied");
  });

  it("rejects token scope unexpectedly broadened by the provider", async () => {
    const cfg = makeTestConfig();
    const adapter = openInstallationSurface({
      lookupInstallation: async () => ({
        id: 42,
        app_id: cfg.github.appId,
        suspended_at: null,
        repository_selection: "selected",
        permissions: { contents: "read", pull_requests: "write" },
      }),
      mintToken: async () => ({
        token: "broader",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
        repositories: ["r", "unrelated"],
      }),
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    await expect(
      adapter.preflight({
        cfg,
        installationId: 42,
        owner: "o",
        repo: "r",
      }),
    ).rejects.toMatchObject({ code: "github.preflight_unavailable" });
  });

  it("keeps other concurrent callers alive when one caller cancels", async () => {
    const cfg = makeTestConfig();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transportSignal: AbortSignal | undefined;
    const lookupInstallation = vi.fn(async (_cfg, _owner, _repo, signal?: AbortSignal) => {
      transportSignal = signal;
      await ready;
      return {
        id: 42,
        app_id: cfg.github.appId,
        suspended_at: null,
        repository_selection: "selected",
        permissions: { contents: "read", pull_requests: "write" },
      };
    });
    const adapter = openInstallationSurface({
      lookupInstallation,
      mintToken: async () => ({
        token: "shared",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
        repositories: ["r"],
      }),
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const controller = new AbortController();
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    const failure = adapter
      .preflight({ ...params, signal: controller.signal })
      .catch((error: unknown) => error);
    const other = adapter.preflight(params);
    controller.abort(new Error("caller cancelled"));
    expect(await failure).toMatchObject({ message: "caller cancelled" });
    expect(transportSignal?.aborted).toBe(false);
    release();
    expect((await other).installation?.token).toBe("shared");
    expect(lookupInstallation).toHaveBeenCalledTimes(1);
  });

  it("does not let a late cancelled mint replace or delete a newer token", async () => {
    const cfg = makeTestConfig();
    let oldMint!: (value: {
      token: string;
      expiresAtTs: number;
      ttlMs: number;
      repositories: string[];
    }) => void;
    const mintToken = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldMint = resolve;
          }),
      )
      .mockResolvedValue({
        token: "new",
        expiresAtTs: Date.now() + 3_600_000,
        ttlMs: 3_600_000,
        repositories: ["r"],
        permissions: { contents: "read", pull_requests: "write" },
      });
    const adapter = openInstallationSurface({
      lookupInstallation: async () => ({
        id: 42,
        app_id: cfg.github.appId,
        suspended_at: null,
        repository_selection: "selected",
        permissions: { contents: "read", pull_requests: "write" },
      }),
      mintToken,
      resolveBot: vi.fn(),
      surface: vi.fn(),
      now: Date.now,
    });
    const params = { cfg, installationId: 42, owner: "o", repo: "r" };
    const controller = new AbortController();
    const failure = adapter
      .preflight({ ...params, signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mintToken).toHaveBeenCalledTimes(1));
    controller.abort(new Error("cancelled"));
    await failure;
    const newer = await adapter.preflight(params);
    expect(newer.installation?.token).toBe("new");
    oldMint({
      token: "old",
      expiresAtTs: Date.now() + 3_600_000,
      ttlMs: 3_600_000,
      repositories: ["r"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect((await adapter.preflight(params)).installation?.token).toBe("new");
    expect(mintToken).toHaveBeenCalledTimes(2);
  });

  it.each(["suspended", "mismatch", "read-denied"])(
    "does not mint when exact metadata proves %s",
    async (mode) => {
      const cfg = makeTestConfig();
      const mintToken = vi.fn();
      const adapter = openInstallationSurface({
        lookupInstallation: async () => ({
          id: mode === "mismatch" ? 43 : 42,
          app_id: cfg.github.appId,
          suspended_at: mode === "suspended" ? "2026-01-01T00:00:00Z" : null,
          repository_selection: "selected",
          permissions:
            mode === "read-denied"
              ? { contents: "read" }
              : { contents: "read", pull_requests: "write" },
        }),
        mintToken,
        resolveBot: vi.fn(),
        surface: vi.fn(),
        now: Date.now,
      });
      const result = await adapter.preflight({ cfg, installationId: 42, owner: "o", repo: "r" });
      expect(result.installation).toBeUndefined();
      expect(result.observation.availability.pullRequestsRead).toBe("denied");
      expect(mintToken).not.toHaveBeenCalled();
    },
  );

  beforeEach(() => {
    installationOctokit = createInstallationOctokitCache();
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
