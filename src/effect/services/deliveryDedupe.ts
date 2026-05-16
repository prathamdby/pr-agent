import crypto from "node:crypto";
import { Clock, Context, Effect, Layer, Ref } from "effect";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class DeliveryDedupe extends Context.Tag("DeliveryDedupe")<
  DeliveryDedupe,
  {
    readonly key: (deliveryId: string | undefined, rawBody: Buffer) => Effect.Effect<string>;
    readonly seenOrMark: (key: string, ttlMs?: number) => Effect.Effect<boolean>;
  }
>() {}

function dedupeKey(deliveryId: string | undefined, rawBody: Buffer): string {
  if (deliveryId && deliveryId.trim().length > 0) return deliveryId;
  return `body:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
}

export const DeliveryDedupeLive = Layer.effect(
  DeliveryDedupe,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, number>>(new Map());

    return DeliveryDedupe.of({
      key: (deliveryId, rawBody) => Effect.sync(() => dedupeKey(deliveryId, rawBody)),
      seenOrMark: (key, ttlMs = DEFAULT_TTL_MS) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* Ref.modify(store, (map) => {
            for (const [k, t] of map) {
              if (now - t > ttlMs) map.delete(k);
            }
            if (map.has(key)) return [true, map] as const;
            map.set(key, now);
            return [false, map] as const;
          });
        }),
    });
  }),
);
