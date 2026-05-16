import { Context, Effect, Layer, Ref } from "effect";
import type { Config } from "../../config.js";
import { mintBotIdentity, type BotIdentity as BotIdentityValue } from "../../github/appAuth.js";

export class BotIdentity extends Context.Tag("BotIdentity")<
  BotIdentity,
  {
    readonly resolve: (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationToken: string,
    ) => Effect.Effect<BotIdentityValue, Error>;
    readonly getUserId: (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationToken: string,
    ) => Effect.Effect<number, Error>;
  }
>() {}

export const BotIdentityLive = Layer.effect(
  BotIdentity,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, BotIdentityValue>>(new Map());

    const resolve = (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationToken: string,
    ): Effect.Effect<BotIdentityValue, Error> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(store);
        const hit = current.get(cfg.githubAppId);
        if (hit) return hit;

        const fresh = yield* Effect.tryPromise({
          try: () => mintBotIdentity(cfg, installationToken),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });
        yield* Ref.update(store, (map) => {
          map.set(cfg.githubAppId, fresh);
          return map;
        });
        return fresh;
      });

    return BotIdentity.of({
      resolve,
      getUserId: (cfg, installationToken) =>
        resolve(cfg, installationToken).pipe(Effect.map((identity) => identity.userId)),
    });
  }),
);
