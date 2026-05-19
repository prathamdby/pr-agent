import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { startAgentWorker } from "./worker.js";

function main() {
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
  });
  logDebug("runtime_selected", { runtime: "effect" });
  if (cfg.role === "worker") {
    startAgentWorker(cfg);
    return;
  }
  startEffectWebhookServer(cfg);
}

main();
