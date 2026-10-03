import { loadConfig, type Config } from "./settings/index.js";
import { initAnalytics } from "./analytics/index.js";
import { initEvlog, logInfo } from "./evlog.js";
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

  initEvlog(cfg.logging.level, {
    maxWideEvents: LOG_MAX_WIDE_EVENTS,
    pretty: cfg.logging.pretty,
    redact: cfg.logging.redact,
  });
  await initAnalytics({ projectToken: cfg.posthog.projectToken, host: cfg.posthog.host });
  logInfo("boot", {
    role: cfg.runtime.role,
    provider: cfg.models.provider,
    model: cfg.models.model,
    context7_enabled: cfg.context7.apiKey.length > 0,
  });
  if (cfg.runtime.role === "worker") {
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
