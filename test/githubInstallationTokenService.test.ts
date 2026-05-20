import { describe, expect, it, vi } from "vitest";
import { Clock, Effect, TestClock, TestContext } from "effect";
import * as appAuth from "../src/github/appAuth.js";
import {
  GithubInstallationToken,
  GithubInstallationTokenLive,
} from "../src/effect/services/githubInstallationToken.js";

const cfg = { githubAppId: "111", githubAppPrivateKey: "k" } as const;

function mockMint(token: string, expiresAt: string) {
  return vi.spyOn(appAuth, "mintInstallationAuth").mockResolvedValue({
    type: "token",
    tokenType: "installation",
    token,
    expiresAt,
    installationId: 1,
  } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
}

describe("GithubInstallationToken service", () => {
  it("returns the cached token within the freshness window", async () => {
    const spy = mockMint("tok-a", new Date(Date.now() + 60 * 60 * 1000).toISOString());

    const program = Effect.gen(function* () {
      const svc = yield* GithubInstallationToken;
      const first = yield* svc.getToken(cfg, 1);
      const second = yield* svc.getToken(cfg, 1);
      return [first, second] as const;
    });

    try {
      const [a, b] = await Effect.runPromise(
        program.pipe(Effect.provide(GithubInstallationTokenLive)),
      );
      expect(a.token).toBe("tok-a");
      expect(b.token).toBe("tok-a");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-mints when the cached token enters the 60s freshness buffer (TestClock)", async () => {
    const start = 0;
    const expiresAtIso = new Date(start + 120_000).toISOString();
    const spy = mockMint("tok-1", expiresAtIso);

    const program = Effect.gen(function* () {
      const svc = yield* GithubInstallationToken;
      const first = yield* svc.getToken(cfg, 7);
      // Advance into the 60s freshness buffer: now > expiresAt - 60s
      yield* TestClock.adjust("65 seconds");
      spy.mockResolvedValueOnce({
        type: "token",
        tokenType: "installation",
        token: "tok-2",
        expiresAt: new Date(start + 65_000 + 120_000).toISOString(),
        installationId: 7,
      } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>);
      const second = yield* svc.getToken(cfg, 7);
      return [first, second] as const;
    });

    try {
      const [a, b] = await Effect.runPromise(
        program.pipe(
          Effect.provide(GithubInstallationTokenLive),
          Effect.provide(TestContext.TestContext),
        ),
      );
      expect(a.token).toBe("tok-1");
      expect(b.token).toBe("tok-2");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("caches per installation id (different ids both mint)", async () => {
    const spy = vi.spyOn(appAuth, "mintInstallationAuth").mockImplementation(
      async (_cfg, id) =>
        ({
          type: "token",
          tokenType: "installation",
          token: `tok-${id}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          installationId: id,
        }) as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>,
    );

    const program = Effect.gen(function* () {
      const svc = yield* GithubInstallationToken;
      const a = yield* svc.getToken(cfg, 1);
      const b = yield* svc.getToken(cfg, 2);
      const aAgain = yield* svc.getToken(cfg, 1);
      return [a, b, aAgain] as const;
    });

    try {
      const [a, b, aAgain] = await Effect.runPromise(
        program.pipe(Effect.provide(GithubInstallationTokenLive)),
      );
      expect(a.token).toBe("tok-1");
      expect(b.token).toBe("tok-2");
      expect(aAgain.token).toBe("tok-1");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("coalesces concurrent misses for the same installation into one mint (TOCTOU guard)", async () => {
    let calls = 0;
    const spy = vi.spyOn(appAuth, "mintInstallationAuth").mockImplementation(async (_cfg, id) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return {
        type: "token",
        tokenType: "installation",
        token: `tok-${id}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        installationId: id,
      } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>;
    });

    const program = Effect.gen(function* () {
      const svc = yield* GithubInstallationToken;
      const tasks = Array.from({ length: 16 }, () => svc.getToken(cfg, 42));
      return yield* Effect.all(tasks, { concurrency: "unbounded" });
    });

    try {
      const results = await Effect.runPromise(
        program.pipe(Effect.provide(GithubInstallationTokenLive)),
      );
      expect(results.every((r) => r.token === "tok-42")).toBe(true);
      expect(calls).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses fallback TTL when auth.expiresAt is unparseable", async () => {
    const spy = mockMint("tok-a", "not-a-valid-date");
    const fallbackTtlMs = 60 * 60 * 1000;

    const program = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const svc = yield* GithubInstallationToken;
      const token = yield* svc.getToken(cfg, 1);
      return { now, token };
    });

    try {
      const { now, token } = await Effect.runPromise(
        program.pipe(
          Effect.provide(GithubInstallationTokenLive),
          Effect.provide(TestContext.TestContext),
        ),
      );
      expect(Number.isFinite(token.expiresAtTs)).toBe(true);
      expect(token.expiresAtTs).toBe(now + fallbackTtlMs);
      expect(token.ttlMs).toBe(fallbackTtlMs);
    } finally {
      spy.mockRestore();
    }
  });

  it("retries after a failed mint (pending entry is cleared)", async () => {
    let calls = 0;
    const spy = vi.spyOn(appAuth, "mintInstallationAuth").mockImplementation(async (_cfg, id) => {
      calls += 1;
      if (calls === 1) throw new Error("mint failed");
      return {
        type: "token",
        tokenType: "installation",
        token: `tok-${id}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        installationId: id,
      } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>;
    });

    const program = Effect.gen(function* () {
      const svc = yield* GithubInstallationToken;
      const first = yield* Effect.either(svc.getToken(cfg, 5));
      const second = yield* svc.getToken(cfg, 5);
      return [first, second] as const;
    });

    try {
      const [first, second] = await Effect.runPromise(
        program.pipe(Effect.provide(GithubInstallationTokenLive)),
      );
      expect(first._tag).toBe("Left");
      expect(second.token).toBe("tok-5");
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
