import { Clock, Context, Effect, Layer, Ref } from "effect";
import type { Config } from "../../config.js";
import { mintInstallationAuth, type CachedInstallationToken } from "../../github/appAuth.js";
import { log } from "../../log.js";

const FRESHNESS_BUFFER_MS = 60_000;
const FALLBACK_TTL_MS = 55 * 60 * 1000;

export class GithubInstallationToken extends Context.Tag("GithubInstallationToken")<
  GithubInstallationToken,
  {
    readonly getToken: (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationId: number,
    ) => Effect.Effect<string, Error>;
  }
>() {}

export const GithubInstallationTokenLive = Layer.effect(
  GithubInstallationToken,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<number, CachedInstallationToken>>(new Map());

    return GithubInstallationToken.of({
      getToken: (cfg, installationId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = yield* Ref.get(store);
          const hit = current.get(installationId);
          if (hit && hit.expiresAtTs - FRESHNESS_BUFFER_MS > now) {
            return hit.token;
          }

          const auth = yield* Effect.tryPromise({
            try: () => mintInstallationAuth(cfg, installationId),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          });
          const expiresAtTs = auth.expiresAt ? Date.parse(auth.expiresAt) : now + FALLBACK_TTL_MS;
          yield* Ref.update(store, (map) => {
            map.set(installationId, { ...auth, expiresAtTs });
            return map;
          });
          log.debug("minted_installation_token", { installationId, expiresAt: auth.expiresAt });
          return auth.token;
        }),
    });
  }),
);