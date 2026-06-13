import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { prewarmAppBotIdentity } from "./github/appAuth.js";
import { startAgentWorker } from "./worker.js";
import { captureCursorWorkerFailure } from "./agent/providers/cursor/cursorAnalytics.js";
import { shutdownPostHog } from "./posthog.js";
async function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
    return;
  }

  initEvlog(cfg.logLevel, {
    maxWideEvents: cfg.logMaxWideEvents,
    pretty: cfg.logPretty,
    redact: cfg.logRedact,
  });
  logInfo("boot", {
    role: cfg.role,
    agentProvider: cfg.agentProvider,
    provider: cfg.piProvider,
    model: cfg.piModel,
    context7_enabled: cfg.context7ApiKey.length > 0,
    cursor_enabled: cfg.agentProvider === "cursor",
  });
  logDebug("runtime_selected", { runtime: "effect" });
  if (cfg.role === "worker") {
    if (cfg.agentProvider === "cursor") {
      try {
        const { initCursorWorker } = await import("./agent/providers/cursor/workerBoot.js");
        const boot = await initCursorWorker(cfg);
        logInfo("cursor_provider_registered", {
          api: "cursor-sdk",
          model_count: boot.modelCount,
          top_models: boot.topModels,
          fast_models: boot.fastModels,
          ripgrep_configured: boot.ripgrepPath != null,
        });
      } catch (e) {
        captureCursorWorkerFailure("worker_boot", e);
        console.error(e instanceof Error ? e.message : e);
        await shutdownPostHog();
        process.exit(1);
        return;
      }
    }
    startAgentWorker(cfg);
    return;
  }
  prewarmAppBotIdentity(cfg);
  startEffectWebhookServer(cfg);
}

void main();
