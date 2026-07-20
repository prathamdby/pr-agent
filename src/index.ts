import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { prewarmAppBotIdentity } from "./github/appAuth.js";
import { startAgentWorker } from "./worker.js";
import { captureAgentProviderBootFailure } from "./agent/providers/bootAnalytics.js";
import { resolveAgentRunnerProvider } from "./agent/providers/index.js";
import { shutdownPostHog } from "./posthog.js";
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
  logInfo("boot", {
    role: cfg.role,
    agentProvider: cfg.agentProvider,
    provider: cfg.piProvider,
    model: cfg.piModel,
    context7_enabled: cfg.context7ApiKey.length > 0,
  });
  logDebug("runtime_selected", { runtime: "effect" });
  if (cfg.role === "worker") {
    try {
      const boot = await resolveAgentRunnerProvider(cfg).boot?.(cfg);
      if (boot) {
        logInfo("agent_provider_registered", {
          provider: cfg.agentProvider,
          model_count: boot.modelCount,
          top_models: boot.topModels,
          fast_models: boot.fastModels,
          ripgrep_configured: boot.ripgrepPath != null,
        });
      }
    } catch (e) {
      captureAgentProviderBootFailure(cfg.agentProvider, e);
      console.error(e instanceof Error ? e.message : e);
      await shutdownPostHog();
      process.exit(1);
    }
    startAgentWorker(cfg);
    return;
  }
  prewarmAppBotIdentity(cfg);
  startEffectWebhookServer(cfg);
}

void main();
