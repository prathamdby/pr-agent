import { describe, expect, it, vi } from "vitest";
import { Effect, Layer, TestClock, TestContext } from "effect";
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
      const [a, b] = await Effect.runPromise(program.pipe(Effect.provide(GithubInstallationTokenLive)));
      expect(a).toBe("tok-a");
      expect(b).toBe("tok-a");
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
      expect(a).toBe("tok-1");
      expect(b).toBe("tok-2");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("caches per installation id (different ids both mint)", async () => {
    const spy = vi
      .spyOn(appAuth, "mintInstallationAuth")
      .mockImplementation(async (_cfg, id) => ({
        type: "token",
        tokenType: "installation",
        token: `tok-${id}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        installationId: id,
      } as Awaited<ReturnType<typeof appAuth.mintInstallationAuth>>));

    const program = Effect.gen(function* () {
      const svc = yield* GithubInstallationToken;
      const a = yield* svc.getToken(cfg, 1);
      const b = yield* svc.getToken(cfg, 2);
      const aAgain = yield* svc.getToken(cfg, 1);
      return [a, b, aAgain] as const;
    });

    try {
      const [a, b, aAgain] = await Effect.runPromise(program.pipe(Effect.provide(GithubInstallationTokenLive)));
      expect(a).toBe("tok-1");
      expect(b).toBe("tok-2");
      expect(aAgain).toBe("tok-1");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
