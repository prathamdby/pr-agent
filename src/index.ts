import { loadConfig, type Config } from "./config.js";
import { initAnalytics } from "./analytics/index.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { sanitizeErrorForTelemetry } from "./errors/appError.js";
import { LOG_MAX_WIDE_EVENTS } from "./settings/index.js";

async function main() {
  let cfg: Config;
  try {
    cfg = await loadConfig();
  } catch (e) {
    console.error(sanitizeErrorForTelemetry(e));
    process.exit(1);
    return;
  }

  initEvlog(cfg.logLevel, {
    maxWideEvents: LOG_MAX_WIDE_EVENTS,
    pretty: cfg.logPretty,
    redact: cfg.logRedact,
  });
  await initAnalytics({ projectToken: cfg.posthogProjectToken, host: cfg.posthogHost });
  logInfo("boot", {
    role: cfg.role,
    provider: cfg.piProvider,
    model: cfg.piModel,
    context7_enabled: cfg.context7ApiKey.length > 0,
  });
  logDebug("runtime_selected", { runtime: "effect" });
  if (cfg.role === "worker") {
    const { startAgentWorker } = await import("./worker.js");
    startAgentWorker(cfg);
    return;
  }
  const [{ prewarmAppBotIdentity }, { startEffectWebhookServer }] = await Promise.all([
    import("./github/appAuth.js"),
    import("./effect/server.js"),
  ]);
  prewarmAppBotIdentity(cfg);
  startEffectWebhookServer(cfg);
}

void main();
