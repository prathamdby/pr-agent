import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Ref, TestClock, TestContext } from "effect";
import { AskQueue, AskQueueLive } from "../src/effect/services/askQueue.js";

describe("AskQueue Layer", () => {
  it("never exceeds the configured concurrency cap", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* AskQueue;
      const inFlight = yield* Ref.make(0);
      const peak = yield* Ref.make(0);

      const makeTask = (label: string) =>
        queue.submit(
          label,
          Effect.gen(function* () {
            yield* Ref.update(inFlight, (n) => n + 1);
            const current = yield* Ref.get(inFlight);
            yield* Ref.update(peak, (p) => Math.max(p, current));
            yield* Effect.sleep(Duration.seconds(1));
            yield* Ref.update(inFlight, (n) => n - 1);
          }),
        );

      const fiber = yield* Effect.fork(
        Effect.all(["a", "b", "c", "d", "e"].map(makeTask), {
          concurrency: "unbounded",
          discard: true,
        }),
      );
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(fiber);
      return [yield* Ref.get(peak), yield* Ref.get(inFlight)] as const;
    });

    const [peakInFlight, residual] = await Effect.runPromise(
      program.pipe(
        Effect.provide(AskQueueLive({ askConcurrency: 2 })),
        Effect.provide(TestContext.TestContext),
      ),
    );

    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(residual).toBe(0);
  });
});
