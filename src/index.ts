import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { prewarmAppBotIdentity } from "./github/appAuth.js";
import { startAgentWorker } from "./worker.js";
import { initAnalytics } from "./analytics/index.js";
import { LOG_MAX_WIDE_EVENTS } from "./settings/index.js";

async function main() {
  let cfg: Config;
  try {
    cfg = await loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
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
    agentProvider: cfg.agentProvider,
    provider: cfg.piProvider,
    model: cfg.piModel,
    context7_enabled: cfg.context7ApiKey.length > 0,
  });
  logDebug("runtime_selected", { runtime: "effect" });
  if (cfg.role === "worker") {
    logInfo("agent_provider_registered", {
      provider: "pi",
      model_count: 1,
      top_models: [`${cfg.piProvider}/${cfg.piModel}`],
      fast_models: [],
      ripgrep_configured: false,
    });
    startAgentWorker(cfg);
    return;
  }
  prewarmAppBotIdentity(cfg);
  startEffectWebhookServer(cfg);
}

void main();
