import { Clock, Deferred, Effect, Ref } from "effect";

type Entry<V> =
  | { readonly tag: "value"; readonly value: V }
  | { readonly tag: "pending"; readonly deferred: Deferred.Deferred<V, Error> };

type StoreAction<V> =
  | { readonly tag: "hit"; readonly value: V }
  | { readonly tag: "wait"; readonly deferred: Deferred.Deferred<V, Error> }
  | { readonly tag: "claim"; readonly deferred: Deferred.Deferred<V, Error> };

export type SingleFlight<K, V> = {
  /**
   * Return the cached value for `key`, attach to an in-flight mint, or run `mint`
   * as the sole minter. Concurrent misses for the same key coalesce into one run;
   * a failed mint clears the pending entry so the next caller retries.
   */
  readonly get: (key: K, mint: Effect.Effect<V, Error>) => Effect.Effect<V, Error>;
};

export type SingleFlightOptions<V> = {
  /** Whether a cached value is still usable at `nowMs`. Omit to cache indefinitely. */
  readonly isFresh?: (value: V, nowMs: number) => boolean;
};

export const makeSingleFlight = <K, V>(
  options?: SingleFlightOptions<V>,
): Effect.Effect<SingleFlight<K, V>> =>
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<K, Entry<V>>>(new Map());
    const isFresh = options?.isFresh;

    const get = (key: K, mint: Effect.Effect<V, Error>): Effect.Effect<V, Error> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const candidate = yield* Deferred.make<V, Error>();

        // Atomic check-and-claim: return existing value, attach to in-flight Deferred, or claim the mint.
        const action = yield* Ref.modify(
          store,
          (map): readonly [StoreAction<V>, Map<K, Entry<V>>] => {
            const hit = map.get(key);
            if (hit && hit.tag === "value" && (isFresh === undefined || isFresh(hit.value, now))) {
              return [{ tag: "hit", value: hit.value }, map];
            }
            if (hit && hit.tag === "pending") {
              return [{ tag: "wait", deferred: hit.deferred }, map];
            }
            map.set(key, { tag: "pending", deferred: candidate });
            return [{ tag: "claim", deferred: candidate }, map];
          },
        );

        if (action.tag === "hit") return action.value;
        if (action.tag === "wait") return yield* Deferred.await(action.deferred);

        return yield* mint.pipe(
          Effect.tap((value) =>
            Effect.gen(function* () {
              yield* Ref.update(store, (m) => {
                m.set(key, { tag: "value", value });
                return m;
              });
              yield* Deferred.succeed(action.deferred, value);
            }),
          ),
          Effect.tapError((err) =>
            Effect.gen(function* () {
              yield* Ref.update(store, (m) => {
                m.delete(key);
                return m;
              });
              yield* Deferred.fail(action.deferred, err);
            }),
          ),
        );
      });

    return { get };
  });
