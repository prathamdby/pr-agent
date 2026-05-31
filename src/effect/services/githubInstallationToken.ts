import { Clock, Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { mintInstallationAuth, type InstallationToken } from "../../github/appAuth.js";
import { INSTALLATION_TOKEN_FALLBACK_TTL_MS } from "../../github/githubRequestError.js";
import { logDebug } from "../../evlog.js";
import { makeSingleFlight } from "./singleFlight.js";

import { TOKEN_FRESHNESS_BUFFER_MS } from "../../settings/index.js";

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
    const cache = yield* makeSingleFlight<number, InstallationToken>({
      isFresh: (token, now) => token.expiresAtTs - TOKEN_FRESHNESS_BUFFER_MS > now,
    });

    return GithubInstallationToken.of({
      getToken: (cfg, installationId) =>
        cache.get(
          installationId,
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const auth = yield* Effect.tryPromise({
              try: () => mintInstallationAuth(cfg, installationId),
              catch: (e) => (e instanceof Error ? e : new Error(String(e))),
            });
            const parsed = auth.expiresAt ? Date.parse(auth.expiresAt) : Number.NaN;
            const expiresAtTs = Number.isFinite(parsed)
              ? parsed
              : now + INSTALLATION_TOKEN_FALLBACK_TTL_MS;
            const ttlMs = Number.isFinite(parsed)
              ? Math.max(0, expiresAtTs - now)
              : INSTALLATION_TOKEN_FALLBACK_TTL_MS;
            logDebug("minted_installation_token", { installationId, expiresAt: auth.expiresAt });
            return { token: auth.token, expiresAtTs, ttlMs } satisfies InstallationToken;
          }),
        ),
    });
  }),
);
