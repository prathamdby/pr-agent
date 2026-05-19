import { Context, Deferred, Effect, Layer, Ref } from "effect";
import type { Config } from "../../config.js";
import { getAppBotIdentity, mintBotIdentity, type BotIdentity as BotIdentityValue } from "../../github/appAuth.js";

type Entry =
  | { readonly tag: "value"; readonly value: BotIdentityValue }
  | { readonly tag: "pending"; readonly deferred: Deferred.Deferred<BotIdentityValue, Error> };

type StoreAction =
  | { readonly tag: "hit"; readonly value: BotIdentityValue }
  | { readonly tag: "wait"; readonly deferred: Deferred.Deferred<BotIdentityValue, Error> }
  | { readonly tag: "claim"; readonly deferred: Deferred.Deferred<BotIdentityValue, Error> };

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
    readonly getAppUserId: (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
    ) => Effect.Effect<number, Error>;
  }
>() {}

export const BotIdentityLive = Layer.effect(
  BotIdentity,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, Entry>>(new Map());

    const resolve = (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationToken: string,
    ): Effect.Effect<BotIdentityValue, Error> =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<BotIdentityValue, Error>();

        // Atomic check-and-claim: return existing value, attach to in-flight Deferred, or claim the mint.
        const action = yield* Ref.modify(store, (map): readonly [StoreAction, Map<string, Entry>] => {
          const hit = map.get(cfg.githubAppId);
          if (hit && hit.tag === "value") return [{ tag: "hit", value: hit.value }, map];
          if (hit && hit.tag === "pending") return [{ tag: "wait", deferred: hit.deferred }, map];
          map.set(cfg.githubAppId, { tag: "pending", deferred: candidate });
          return [{ tag: "claim", deferred: candidate }, map];
        });

        if (action.tag === "hit") return action.value;
        if (action.tag === "wait") return yield* Deferred.await(action.deferred);

        // Sole minter: on failure clear the pending entry so a later caller retries.
        return yield* Effect.tryPromise({
          try: () => mintBotIdentity(cfg, installationToken),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(
          Effect.tap((value) =>
            Effect.gen(function* () {
              yield* Ref.update(store, (m) => {
                m.set(cfg.githubAppId, { tag: "value", value });
                return m;
              });
              yield* Deferred.succeed(action.deferred, value);
            }),
          ),
          Effect.tapError((err) =>
            Effect.gen(function* () {
              yield* Ref.update(store, (m) => {
                m.delete(cfg.githubAppId);
                return m;
              });
              yield* Deferred.fail(action.deferred, err);
            }),
          ),
        );
      });

    return BotIdentity.of({
      resolve,
      getUserId: (cfg, installationToken) =>
        resolve(cfg, installationToken).pipe(Effect.map((identity) => identity.userId)),
      getAppUserId: (cfg) =>
        Effect.tryPromise({
          try: () => getAppBotIdentity(cfg),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.map((identity) => identity.userId)),
    });
  }),
);
