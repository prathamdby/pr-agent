import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as appAuth from "../src/github/appAuth.js";
import { BotIdentity, BotIdentityLive } from "../src/effect/services/botIdentity.js";

describe("BotIdentity service", () => {
  it("caches by GitHub App id across calls", async () => {
    const spy = vi.spyOn(appAuth, "mintBotIdentity").mockResolvedValue({ userId: 42, login: "app[bot]" });

    const program = Effect.gen(function* () {
      const svc = yield* BotIdentity;
      const first = yield* svc.getUserId({ githubAppId: "A", githubAppPrivateKey: "k" }, "tok");
      const second = yield* svc.getUserId({ githubAppId: "A", githubAppPrivateKey: "k" }, "tok");
      return [first, second] as const;
    });

    try {
      const [a, b] = await Effect.runPromise(program.pipe(Effect.provide(BotIdentityLive)));
      expect(a).toBe(42);
      expect(b).toBe(42);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("separates cache per githubAppId", async () => {
    const spy = vi
      .spyOn(appAuth, "mintBotIdentity")
      .mockImplementation(async (cfg) => ({ userId: cfg.githubAppId === "A" ? 1 : 2, login: cfg.githubAppId }));

    const program = Effect.gen(function* () {
      const svc = yield* BotIdentity;
      const a = yield* svc.getUserId({ githubAppId: "A", githubAppPrivateKey: "k" }, "tA");
      const b = yield* svc.getUserId({ githubAppId: "B", githubAppPrivateKey: "k" }, "tB");
      const aAgain = yield* svc.getUserId({ githubAppId: "A", githubAppPrivateKey: "k" }, "tA");
      return [a, b, aAgain] as const;
    });

    try {
      const [a, b, aAgain] = await Effect.runPromise(program.pipe(Effect.provide(BotIdentityLive)));
      expect(a).toBe(1);
      expect(b).toBe(2);
      expect(aAgain).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
