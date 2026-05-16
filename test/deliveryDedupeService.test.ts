import { describe, expect, it } from "vitest";
import { Effect, TestClock, TestContext } from "effect";
import { DeliveryDedupe, DeliveryDedupeLive } from "../src/effect/services/deliveryDedupe.js";

describe("DeliveryDedupe service", () => {
  it("key returns delivery id when provided", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* DeliveryDedupe;
      return yield* svc.key("abc-123", Buffer.alloc(0));
    });
    const out = await Effect.runPromise(program.pipe(Effect.provide(DeliveryDedupeLive)));
    expect(out).toBe("abc-123");
  });

  it("key falls back to body hash when delivery missing", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* DeliveryDedupe;
      return yield* svc.key(undefined, Buffer.from('{"a":1}'));
    });
    const out = await Effect.runPromise(program.pipe(Effect.provide(DeliveryDedupeLive)));
    expect(out.startsWith("body:")).toBe(true);
    expect(out.length).toBeGreaterThan(10);
  });

  it("seenOrMark returns false on first sight and true on repeat", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* DeliveryDedupe;
      const key = `k-${Math.random()}`;
      const first = yield* svc.seenOrMark(key);
      const second = yield* svc.seenOrMark(key);
      return [first, second] as const;
    });
    const [first, second] = await Effect.runPromise(program.pipe(Effect.provide(DeliveryDedupeLive)));
    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it("isolates state across layer instantiations", async () => {
    const seenKey = `iso-${Math.random()}`;
    const program = Effect.gen(function* () {
      const svc = yield* DeliveryDedupe;
      return yield* svc.seenOrMark(seenKey);
    });
    const a = await Effect.runPromise(program.pipe(Effect.provide(DeliveryDedupeLive)));
    const b = await Effect.runPromise(program.pipe(Effect.provide(DeliveryDedupeLive)));
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it("evicts an entry after the TTL elapses (TestClock)", async () => {
    const ttlMs = 60_000;
    const key = `ttl-${Math.random()}`;

    const program = Effect.gen(function* () {
      const svc = yield* DeliveryDedupe;
      const first = yield* svc.seenOrMark(key, ttlMs);
      // Within TTL: still seen
      yield* TestClock.adjust(`${ttlMs - 1} millis`);
      const secondWithinTtl = yield* svc.seenOrMark(key, ttlMs);
      // Past TTL: pruned, treated as first-sight again
      yield* TestClock.adjust("2 millis");
      const thirdPastTtl = yield* svc.seenOrMark(key, ttlMs);
      return [first, secondWithinTtl, thirdPastTtl] as const;
    });

    const [first, secondWithinTtl, thirdPastTtl] = await Effect.runPromise(
      program.pipe(Effect.provide(DeliveryDedupeLive), Effect.provide(TestContext.TestContext)),
    );

    expect(first).toBe(false);
    expect(secondWithinTtl).toBe(true);
    expect(thirdPastTtl).toBe(false);
  });

  it("under concurrent seenOrMark for the same key, exactly one caller wins (atomic Ref.modify)", async () => {
    const key = `concurrent-${Math.random()}`;
    const callers = 32;

    const program = Effect.gen(function* () {
      const svc = yield* DeliveryDedupe;
      const tasks = Array.from({ length: callers }, () => svc.seenOrMark(key));
      return yield* Effect.all(tasks, { concurrency: "unbounded" });
    });

    const results = await Effect.runPromise(program.pipe(Effect.provide(DeliveryDedupeLive)));
    const winners = results.filter((r) => r === false).length;
    expect(winners).toBe(1);
    expect(results.filter((r) => r === true).length).toBe(callers - 1);
  });
});
