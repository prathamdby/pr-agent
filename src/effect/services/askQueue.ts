import { Clock, Context, Effect, Layer } from "effect";
import type { Config } from "../../config.js";
import { logInfo, logWarn, logError, logDebug } from "../../evlog.js";

export class AskQueue extends Context.Tag("AskQueue")<
	AskQueue,
	{
		readonly submit: <A, E>(
			label: string,
			task: Effect.Effect<A, E>,
		) => Effect.Effect<A, E>;
	}
>() {}

export const AskQueueLive = (cfg: Pick<Config, "askConcurrency">) =>
	Layer.effect(
		AskQueue,
		Effect.gen(function* () {
			const sem = yield* Effect.makeSemaphore(cfg.askConcurrency);

			return AskQueue.of({
				submit: <A, E>(label: string, task: Effect.Effect<A, E>) =>
					Effect.gen(function* () {
						const queuedAt = yield* Clock.currentTimeMillis;
						return yield* sem.withPermits(1)(
							Effect.gen(function* () {
								const now = yield* Clock.currentTimeMillis;
								const waitMs = now - queuedAt;
								if (waitMs > 0) {
									logInfo("ask_queue_wait", { label, waitMs });
								}
								return yield* task;
							}),
						);
					}),
			});
		}),
	);
