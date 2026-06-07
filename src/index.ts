import { loadConfig, type Config } from "./config.js";
import { initEvlog, logDebug, logInfo } from "./evlog.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { startAgentWorker } from "./worker.js";
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
      const { getFastParamModelIds, initCursorModelCapabilities } =
        await import("./agent/providers/cursor/modelCapabilities.js");
      const { assertCursorModelFastSelection } =
        await import("./agent/providers/cursor/models.js");
      const { registerCursorProvider } = await import("./agent/providers/cursor/register.js");
      await initCursorModelCapabilities(cfg.cursorApiKey);
      assertCursorModelFastSelection(cfg.piModel);
      registerCursorProvider();
      logInfo("cursor_provider_registered", {
        api: "cursor-sdk",
        fast_models: [...getFastParamModelIds()],
      });
    }
    startAgentWorker(cfg);
    return;
  }
  startEffectWebhookServer(cfg);
}

void main();
