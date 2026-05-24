import { Clock, Context, Deferred, Effect, Layer, Ref } from "effect";
import type { Config } from "../../config.js";
import { mintInstallationAuth, type InstallationToken } from "../../github/appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../../github/githubRequestError.js";
import { logDebug } from "../../evlog.js";

import { TOKEN_FRESHNESS_BUFFER_MS } from "../../settings/index.js";

type Entry =
  | { readonly tag: "value"; readonly token: InstallationToken }
  | { readonly tag: "pending"; readonly deferred: Deferred.Deferred<InstallationToken, Error> };

type StoreAction =
  | { readonly tag: "hit"; readonly token: InstallationToken }
  | { readonly tag: "wait"; readonly deferred: Deferred.Deferred<InstallationToken, Error> }
  | { readonly tag: "claim"; readonly deferred: Deferred.Deferred<InstallationToken, Error> };

export class GithubInstallationToken extends Context.Tag("GithubInstallationToken")<
  GithubInstallationToken,
  {
    readonly getToken: (
      cfg: Pick<Config, "githubAppId" | "githubAppPrivateKey">,
      installationId: number,
    ) => Effect.Effect<InstallationToken, Error>;
  }
>() {}

export const GithubInstallationTokenLive = Layer.effect(
  GithubInstallationToken,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<number, Entry>>(new Map());

    return GithubInstallationToken.of({
      getToken: (cfg, installationId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const candidate = yield* Deferred.make<InstallationToken, Error>();

          const action = yield* Ref.modify(
            store,
            (map): readonly [StoreAction, Map<number, Entry>] => {
              const hit = map.get(installationId);
              if (
                hit &&
                hit.tag === "value" &&
                hit.token.expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS > now
              ) {
                return [{ tag: "hit", token: hit.token }, map];
              }
              if (hit && hit.tag === "pending") {
                return [{ tag: "wait", deferred: hit.deferred }, map];
              }
              map.set(installationId, { tag: "pending", deferred: candidate });
              return [{ tag: "claim", deferred: candidate }, map];
            },
          );

          if (action.tag === "hit") return action.token;
          if (action.tag === "wait") return yield* Deferred.await(action.deferred);

          return yield* Effect.tryPromise({
            try: () => mintInstallationAuth(cfg, installationId),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }).pipe(
            Effect.flatMap((auth) => {
              const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
              const expiresAtTs = Number.isFinite(parsed)
                ? parsed
                : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
              const ttlMs = Number.isFinite(parsed)
                ? Math.max(0, expiresAtTs - now)
                : INSTALLATION_TOKEN_FALLBACK_TTL_MS;
              const value: InstallationToken = { token: auth.token, expiresAtTs, ttlMs };
              return Effect.gen(function* () {
                yield* Ref.update(store, (m) => {
                  m.set(installationId, { tag: "value", token: value });
                  return m;
                });
                yield* Deferred.succeed(action.deferred, value);
                logDebug("minted_installation_token", {
                  installationId,
                  expiresAt: auth.expiresAt,
                });
                return value;
              });
            }),
            Effect.tapError((err) =>
              Effect.gen(function* () {
                yield* Ref.update(store, (m) => {
                  m.delete(installationId);
                  return m;
                });
                yield* Deferred.fail(action.deferred, err);
              }),
            ),
          );
        }),
    });
  }),
);
