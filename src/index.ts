import { loadConfig, type Config } from "./config.js";
import { initLog, log } from "./log.js";
import { startEffectWebhookServer } from "./effect/server.js";
import { configureReviewQueue } from "./agent/reviewQueue.js";

function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
    return;
  }

  initLog(cfg.logLevel);
  configureReviewQueue(cfg.reviewConcurrency);
  log.info("boot", { provider: cfg.piProvider, model: cfg.piModel });
  log.info("runtime_selected", { runtime: "effect" });
  startEffectWebhookServer(cfg);
}

main();
