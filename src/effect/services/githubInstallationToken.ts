import { Clock, Context, Deferred, Effect, Layer, Ref } from "effect";
import type { Config } from "../../config.js";
import { mintInstallationAuth } from "../../github/appAuth.js";
import { log } from "../../log.js";

const FRESHNESS_BUFFER_MS = 60_000;
const FALLBACK_TTL_MS = 55 * 60 * 1000;

type Entry =
  | { readonly tag: "value"; readonly token: string; readonly expiresAtTs: number }
  | { readonly tag: "pending"; readonly deferred: Deferred.Deferred<string, Error> };

type StoreAction =
  | { readonly tag: "hit"; readonly token: string }
  | { readonly tag: "wait"; readonly deferred: Deferred.Deferred<string, Error> }
  | { readonly tag: "claim"; readonly deferred: Deferred.Deferred<string, Error> };

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
    const store = yield* Ref.make<Map<number, Entry>>(new Map());

    return GithubInstallationToken.of({
      getToken: (cfg, installationId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const candidate = yield* Deferred.make<string, Error>();

          // Atomic check-and-claim: return fresh token, attach to in-flight mint, or claim
          // the mint slot ourselves. Expired entries fall through to the claim branch.
          const action = yield* Ref.modify(store, (map): readonly [StoreAction, Map<number, Entry>] => {
            const hit = map.get(installationId);
            if (hit && hit.tag === "value" && hit.expiresAtTs - FRESHNESS_BUFFER_MS > now) {
              return [{ tag: "hit", token: hit.token }, map];
            }
            if (hit && hit.tag === "pending") {
              return [{ tag: "wait", deferred: hit.deferred }, map];
            }
            map.set(installationId, { tag: "pending", deferred: candidate });
            return [{ tag: "claim", deferred: candidate }, map];
          });

          if (action.tag === "hit") return action.token;
          if (action.tag === "wait") return yield* Deferred.await(action.deferred);

          // Claim path: we own the mint. Publish on success; clear on failure so the next
          // caller can retry.
          return yield* Effect.tryPromise({
            try: () => mintInstallationAuth(cfg, installationId),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }).pipe(
            Effect.tap((auth) =>
              Effect.gen(function* () {
                const mintedAt = yield* Clock.currentTimeMillis;
                const expiresAtTs = auth.expiresAt ? Date.parse(auth.expiresAt) : mintedAt + FALLBACK_TTL_MS;
                yield* Ref.update(store, (m) => {
                  m.set(installationId, { tag: "value", token: auth.token, expiresAtTs });
                  return m;
                });
                yield* Deferred.succeed(action.deferred, auth.token);
                log.debug("minted_installation_token", { installationId, expiresAt: auth.expiresAt });
              }),
            ),
            Effect.tapError((err) =>
              Effect.gen(function* () {
                yield* Ref.update(store, (m) => {
                  m.delete(installationId);
                  return m;
                });
                yield* Deferred.fail(action.deferred, err);
              }),
            ),
            Effect.map((auth) => auth.token),
          );
        }),
    });
  }),
);
