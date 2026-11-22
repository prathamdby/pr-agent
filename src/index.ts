import { Cause, Effect, Exit, Fiber } from "effect";
import { LOG_MAX_WIDE_EVENTS, loadConfig, type Config } from "./settings/index.ts";
import { initAnalytics, shutdownAnalytics } from "./analytics/index.ts";
import { initEvlog, logError, logInfo } from "./evlog.ts";
import { sanitizeErrorForTelemetry } from "./errors/appError.ts";
import { initTraces } from "./traces/recorder.ts";
import { openAppState } from "./state/db.ts";
import { applyAppStateSchema } from "./state/schema.ts";
import { productionInstallationSurface } from "./agentWork/installationSurface.ts";
import { prewarmAppBotIdentity } from "./github/appAuth.ts";
import { getSharedDurableRuntime, openDurableRuntime } from "./agent/runtime/durable/runtime.ts";
import { intentSurfaceFromWorkRuns, startDurableService } from "./agent/runtime/durable/boot.ts";
import {
  createAckHandler,
  createFeatureExecutors,
  runDueCiProjections,
} from "./agent/runtime/durable/featureExecutors.ts";
import { createReviewRunner } from "./agent/runtime/durable/reviewOrchestratorTask.ts";
import { makeSqliteWebhookIntake } from "./effect/webhookIntake.ts";
import { startEffectWebhookServer } from "./effect/server.ts";

async function startSingleProcess(cfg: Config) {
  const appState = openAppState({
    sqliteDir: cfg.runtime.sqliteDir,
    ...(cfg.runtime.sqliteDbPath !== null ? { dbPath: cfg.runtime.sqliteDbPath } : {}),
    applySchema: applyAppStateSchema,
  });
  try {
    const runtime = await getSharedDurableRuntime(cfg);
    const installationSurface = productionInstallationSurface;
    const service = await startDurableService({
      appState,
      cfg,
      runtime,
      reopenRuntime: () => openDurableRuntime(cfg),
      installationSurface,
      createHandlers: (deps) => ({
        review: createReviewRunner(deps),
        feature: createFeatureExecutors(deps),
        ack: createAckHandler(deps),
      }),
      createCiProjectionRunner: (deps) => async (now) => {
        runDueCiProjections(deps, now);
      },
      surfaceFor: intentSurfaceFromWorkRuns({ db: appState.db, cfg, installationSurface }),
    });
    return { appState, service };
  } catch (error) {
    appState.close();
    throw error;
  }
}

async function main() {
  let cfg: Config;
  try {
    cfg = await loadConfig();
  } catch (error) {
    process.stderr.write(`StartupConfigInvalid: ${sanitizeErrorForTelemetry(error).message}\n`);
    return 1;
  }
  initEvlog(cfg.logging.level, {
    maxWideEvents: LOG_MAX_WIDE_EVENTS,
    pretty: cfg.logging.pretty,
    redact: cfg.logging.redact,
  });
  await initAnalytics({ projectToken: cfg.posthog.projectToken, host: cfg.posthog.host });
  const closeTraces = initTraces(cfg);
  logInfo("boot", {
    provider: cfg.models.provider,
    model: cfg.models.model,
    sqliteDir: cfg.runtime.sqliteDir,
  });
  let started: Awaited<ReturnType<typeof startSingleProcess>>;
  try {
    started = await startSingleProcess(cfg);
  } catch (error) {
    logError("boot_failed", { message: sanitizeErrorForTelemetry(error).message });
    await closeTraces();
    await shutdownAnalytics();
    return 1;
  }
  const { appState, service } = started;
  prewarmAppBotIdentity(cfg);
  const server = Effect.runFork(
    startEffectWebhookServer(
      cfg,
      makeSqliteWebhookIntake({
        db: appState.db,
        cfg,
        accepting: service.acceptingWebhooks,
        ready: service.ready,
        afterCommit: service.afterIntakeCommit,
      }),
    ),
  );
  const stopWatchingServer = server.addObserver((exit) => {
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      logError("http_server_failed", {
        port: cfg.runtime.port,
        message: sanitizeErrorForTelemetry(error instanceof Error ? (error.cause ?? error) : error)
          .message,
      });
    }
    void service.shutdown("http_server_stopped", 1);
  });
  const onSignal = (signal: NodeJS.Signals) => {
    void service.shutdown(signal);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const exitCode = await service.exited;
  stopWatchingServer();
  await Effect.runPromise(Fiber.interrupt(server));
  await closeTraces();
  await shutdownAnalytics();
  logInfo("process_exit", { exitCode });
  return exitCode;
}

void main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`fatal: ${sanitizeErrorForTelemetry(error).message}\n`);
    process.exit(1);
  },
);
