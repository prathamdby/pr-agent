import { Data, Effect } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { LOG_MAX_WIDE_EVENTS, loadConfig } from "./settings/index.ts";
import { initAnalytics } from "./analytics/index.ts";
import { initEvlog, logInfo } from "./evlog.ts";
import { sanitizeErrorForTelemetry } from "./errors/appError.ts";

class StartupConfigInvalid extends Data.TaggedError("StartupConfigInvalid")<{
  readonly message: string;
}> {}

const boot = Effect.fn("process.boot")(function* () {
  const cfg = yield* Effect.tryPromise({
    try: () => loadConfig(),
    catch: (cause) =>
      new StartupConfigInvalid({ message: sanitizeErrorForTelemetry(cause).message }),
  });
  yield* Effect.sync(() => {
    initEvlog(cfg.logging.level, {
      maxWideEvents: LOG_MAX_WIDE_EVENTS,
      pretty: cfg.logging.pretty,
      redact: cfg.logging.redact,
    });
  });
  yield* Effect.promise(() =>
    initAnalytics({ projectToken: cfg.posthog.projectToken, host: cfg.posthog.host }),
  );
  logInfo("boot", {
    role: cfg.runtime.role,
    provider: cfg.models.provider,
    model: cfg.models.model,
  });
  if (cfg.runtime.role === "worker") {
    const { startAgentWorker } = yield* Effect.promise(() => import("./worker.ts"));
    yield* startAgentWorker(cfg);
    return;
  }
  const [{ prewarmAppBotIdentity }, { startEffectWebhookServer }] = yield* Effect.promise(() =>
    Promise.all([import("./github/appAuth.ts"), import("./effect/server.ts")]),
  );
  prewarmAppBotIdentity(cfg);
  yield* startEffectWebhookServer(cfg);
});

NodeRuntime.runMain(boot());
