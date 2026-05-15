import { loadConfig, type Config } from "./config.js";
import { initLog, log } from "./log.js";
import { startWebhookServer } from "./webhook/server.js";

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
	log.info("boot", { provider: cfg.piProvider, model: cfg.piModel });

	startWebhookServer(cfg);
}

main();
