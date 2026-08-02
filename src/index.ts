import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { initAnalytics, setAnalyticsRuntimeContext } from "./analytics/index.js";
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
  const release = process.env.GITHUB_SHA?.slice(0, 12) ?? process.env.COMMIT_SHA?.slice(0, 12);
  setAnalyticsRuntimeContext({
    role: cfg.role,
    service: "pr-agent",
    ...(release ? { release } : {}),
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
