import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { startAgentWorker } from "./worker.js";
import { isCursorProvider } from "./agent/cursor/models.js";

async function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
    return;
  }

  initEvlog(cfg.logLevel, { maxWideEvents: cfg.logMaxWideEvents, pretty: cfg.logPretty });
  logInfo("boot", {
    role: cfg.role,
    provider: cfg.piProvider,
    model: cfg.piModel,
    context7_enabled: cfg.context7ApiKey.length > 0,
    cursor_enabled: isCursorProvider(cfg.piProvider),
  });
  logDebug("runtime_selected", { runtime: "effect" });
  if (cfg.role === "worker") {
    if (isCursorProvider(cfg.piProvider)) {
      const { registerCursorProvider } = await import("./agent/cursor/register.js");
      registerCursorProvider();
      logInfo("cursor_provider_registered", { api: "cursor-sdk" });
    }
    startAgentWorker(cfg);
    return;
  }
  startEffectWebhookServer(cfg);
}

void main();
