import { Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import {
  getAppBotIdentity,
  mintBotIdentity,
  type BotIdentity as BotIdentityValue,
} from "../../github/appAuth.js";
import { makeSingleFlight } from "./singleFlight.js";

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
    const cache = yield* makeSingleFlight<string, BotIdentityValue>();

    const resolve = (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationToken: string,
    ): Effect.Effect<BotIdentityValue, Error> =>
      cache.get(
        cfg.githubAppId,
        Effect.tryPromise({
          try: () => mintBotIdentity(cfg, installationToken),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }),
      );

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
