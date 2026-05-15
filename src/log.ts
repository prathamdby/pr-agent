import type { Config } from "./config.js";

const levelRank: Record<Config["logLevel"], number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

let minLevel: Config["logLevel"] = "info";

export function initLog(level: Config["logLevel"]) {
	minLevel = level;
}

function shouldLog(level: Config["logLevel"]): boolean {
	return levelRank[level] >= levelRank[minLevel];
}

export const log = {
	debug(msg: string, meta?: Record<string, unknown>) {
		if (!shouldLog("debug")) return;
		if (meta) console.debug(`[pr-agent] ${msg}`, meta);
		else console.debug(`[pr-agent] ${msg}`);
	},
	info(msg: string, meta?: Record<string, unknown>) {
		if (!shouldLog("info")) return;
		if (meta) console.info(`[pr-agent] ${msg}`, meta);
		else console.info(`[pr-agent] ${msg}`);
	},
	warn(msg: string, meta?: Record<string, unknown>) {
		if (!shouldLog("warn")) return;
		if (meta) console.warn(`[pr-agent] ${msg}`, meta);
		else console.warn(`[pr-agent] ${msg}`);
	},
	error(msg: string, meta?: Record<string, unknown>) {
		if (!shouldLog("error")) return;
		if (meta) console.error(`[pr-agent] ${msg}`, meta);
		else console.error(`[pr-agent] ${msg}`);
	},
};
