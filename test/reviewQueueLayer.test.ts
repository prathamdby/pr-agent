import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Ref, TestClock, TestContext } from "effect";
import { ReviewQueue, ReviewQueueLive } from "../src/effect/services/reviewQueue.js";

describe("ReviewQueue Layer", () => {
	it("never exceeds the configured concurrency cap (cap = 2, burst of 5)", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* ReviewQueue;

			const inFlight = yield* Ref.make(0);
			const peak = yield* Ref.make(0);

			const makeTask = (label: string) =>
				queue.submit(
					label,
					Effect.gen(function* () {
						yield* Ref.update(inFlight, (n) => n + 1);
						yield* Ref.update(peak, (current) =>
							Math.max(current, /* read */ 0),
						);
						const current = yield* Ref.get(inFlight);
						yield* Ref.update(peak, (p) => Math.max(p, current));
						yield* Effect.sleep(Duration.seconds(1));
						yield* Ref.update(inFlight, (n) => n - 1);
					}),
				);

			const fiber = yield* Effect.fork(
				Effect.all(
					["t1", "t2", "t3", "t4", "t5"].map(makeTask),
					{ concurrency: "unbounded", discard: true },
				),
			);

			yield* TestClock.adjust(Duration.seconds(5));
			yield* Fiber.join(fiber);

			return [yield* Ref.get(peak), yield* Ref.get(inFlight)] as const;
		});

		const [peakInFlight, residualInFlight] = await Effect.runPromise(
			program.pipe(
				Effect.provide(ReviewQueueLive({ reviewConcurrency: 2 })),
				Effect.provide(TestContext.TestContext),
			),
		);

		expect(peakInFlight).toBeLessThanOrEqual(2);
		expect(residualInFlight).toBe(0);
	});

	it("completes all submitted tasks (no starvation under burst)", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* ReviewQueue;
			const completed = yield* Ref.make<Array<string>>([]);

			const makeTask = (label: string) =>
				queue.submit(
					label,
					Effect.gen(function* () {
						yield* Effect.sleep(Duration.millis(10));
						yield* Ref.update(completed, (xs) => [...xs, label]);
					}),
				);

			const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
			const fiber = yield* Effect.fork(
				Effect.all(labels.map(makeTask), { concurrency: "unbounded", discard: true }),
			);
			yield* TestClock.adjust(Duration.seconds(1));
			yield* Fiber.join(fiber);

			return yield* Ref.get(completed);
		});

		const completed = await Effect.runPromise(
			program.pipe(
				Effect.provide(ReviewQueueLive({ reviewConcurrency: 3 })),
				Effect.provide(TestContext.TestContext),
			),
		);

		expect(new Set(completed)).toEqual(new Set(["a", "b", "c", "d", "e", "f", "g", "h"]));
	});

	it("returns the inner Effect's value through submit", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* ReviewQueue;
			return yield* queue.submit("solo", Effect.succeed(42));
		});

		const result = await Effect.runPromise(
			program.pipe(Effect.provide(ReviewQueueLive({ reviewConcurrency: 1 }))),
		);

		expect(result).toBe(42);
	});

	it("propagates inner Effect failures through submit", async () => {
		const program = Effect.gen(function* () {
			const queue = yield* ReviewQueue;
			return yield* queue.submit("fail", Effect.fail(new Error("inner failed")));
		});

		await expect(
			Effect.runPromise(program.pipe(Effect.provide(ReviewQueueLive({ reviewConcurrency: 1 })))),
		).rejects.toThrow(/inner failed/);
	});
});
