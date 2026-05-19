import { Clock, Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { logInfo, logWarn, logError, logDebug } from "../../evlog.js";

export class ReviewQueue extends Context.Tag("ReviewQueue")<
	ReviewQueue,
	{
		readonly submit: <A, E>(
			label: string,
			task: Effect.Effect<A, E>,
		) => Effect.Effect<A, E>;
	}
>() {}

export const ReviewQueueLive = (cfg: Pick<Config, "reviewConcurrency">) =>
	Layer.effect(
		ReviewQueue,
		Effect.gen(function* () {
			const sem = yield* Effect.makeSemaphore(cfg.reviewConcurrency);

			return ReviewQueue.of({
				submit: <A, E>(label: string, task: Effect.Effect<A, E>) =>
					Effect.gen(function* () {
						const queuedAt = yield* Clock.currentTimeMillis;
						return yield* sem.withPermits(1)(
							Effect.gen(function* () {
								const now = yield* Clock.currentTimeMillis;
								const waitMs = now - queuedAt;
								if (waitMs > 0) {
									logInfo("review_queue_wait", { label, waitMs });
								}
								return yield* task;
							}),
						);
					}),
			});
		}),
	);
