import {
	createError,
	createRequestLogger,
	initLogger,
	log as globalLog,
	parseError,
	type RequestLogger,
} from "evlog";
import { createLoggerStorage } from "evlog/toolkit";
import type { Config } from "./config.js";

export { createError, parseError, globalLog as log };
export type { RequestLogger };

export type WideEventLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<WideEventLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export const DEFAULT_MAX_WIDE_EVENTS = 128;

let globalMinLevel: WideEventLevel = "info";
let globalMaxWideEvents = DEFAULT_MAX_WIDE_EVENTS;

const { storage, useLogger: useLoggerFromStorage } = createLoggerStorage(
	"evlog: call initEvlog() at boot and run handlers inside runWithOperationLogger()",
);

export function isLevelEnabled(level: WideEventLevel): boolean {
	return LEVEL_RANK[level] >= LEVEL_RANK[globalMinLevel];
}

export function useLogger(): RequestLogger {
	return useLoggerFromStorage();
}

export function tryUseLogger(): RequestLogger | undefined {
	try {
		return useLoggerFromStorage();
	} catch {
		return undefined;
	}
}

function eventsArray(logger: RequestLogger): Array<Record<string, unknown>> {
	const ctx = logger.getContext();
	if (!Array.isArray(ctx.events)) {
		logger.set({ events: [] });
	}
	return logger.getContext().events as Array<Record<string, unknown>>;
}

function filterEventsInPlace(logger: RequestLogger): void {
	const events = eventsArray(logger);
	let write = 0;
	for (const entry of events) {
		const level = (entry.level as WideEventLevel | undefined) ?? "info";
		if (!isLevelEnabled(level)) continue;
		events[write] = entry;
		write++;
	}
	events.length = write;
}

/** Append a named sub-event while accumulating one wide event per operation. */
export function recordEvent(
	logger: RequestLogger,
	event: string,
	fields?: Record<string, unknown>,
	level: WideEventLevel = "info",
): void {
	if (!isLevelEnabled(level)) return;

	const events = eventsArray(logger);
	const ctx = logger.getContext();
	const dropped = typeof ctx.eventsDropped === "number" ? ctx.eventsDropped : 0;

	if (events.length >= globalMaxWideEvents) {
		logger.set({ eventsDropped: dropped + 1, lastEvent: "events_truncated" });
		return;
	}

	events.push({ event, level, ...(fields ?? {}), at: Date.now() });
	logger.set({ lastEvent: event });
}

function recordOrGlobal(
	level: WideEventLevel,
	globalFn: (payload: Record<string, unknown>) => void,
	event: string,
	meta?: Record<string, unknown>,
): void {
	const logger = tryUseLogger();
	if (logger) {
		recordEvent(logger, event, meta, level);
		return;
	}
	if (!isLevelEnabled(level)) return;
	globalFn({ event, ...(meta ?? {}) });
}

export function logDebug(event: string, meta?: Record<string, unknown>): void {
	recordOrGlobal("debug", (p) => globalLog.debug(p), event, meta);
}

export function logInfo(event: string, meta?: Record<string, unknown>): void {
	recordOrGlobal("info", (p) => globalLog.info(p), event, meta);
}

export function logWarn(event: string, meta?: Record<string, unknown>): void {
	recordOrGlobal("warn", (p) => globalLog.warn(p), event, meta);
}

export function logError(event: string, meta?: Record<string, unknown>): void {
	recordOrGlobal("error", (p) => globalLog.error(p), event, meta);
}

export type OperationLoggerMeta = {
	readonly method: string;
	readonly path: string;
	readonly requestId?: string;
	readonly context?: Record<string, unknown>;
};

export function initEvlog(
	logLevel: Config["logLevel"],
	options?: {
		silent?: boolean;
		suppressDrainWarning?: boolean;
		maxWideEvents?: number;
		pretty?: boolean;
	},
): void {
	globalMinLevel = logLevel;
	globalMaxWideEvents = options?.maxWideEvents ?? DEFAULT_MAX_WIDE_EVENTS;

	const isProduction = process.env.NODE_ENV === "production";
	initLogger({
		env: {
			service: "pr-agent",
			environment: (process.env.NODE_ENV ?? "development") as "development" | "production" | "test",
		},
		minLevel: logLevel,
		pretty: options?.pretty ?? !isProduction,
		redact: isProduction,
		silent: options?.silent ?? false,
		_suppressDrainWarning: options?.suppressDrainWarning ?? false,
	});
}

export function createOperationLogger(meta: OperationLoggerMeta): RequestLogger {
	const logger = createRequestLogger({
		method: meta.method,
		path: meta.path,
		requestId: meta.requestId,
	});
	if (meta.context) logger.set(meta.context);
	return logger;
}

async function emitPrepared(
	logger: RequestLogger,
	overrides?: Record<string, unknown>,
): Promise<void> {
	filterEventsInPlace(logger);
	logger.set({ emitted: true });
	await logger.emit(overrides);
}

export async function runWithOperationLogger<T>(
	meta: OperationLoggerMeta,
	fn: () => Promise<T>,
): Promise<T> {
	const opLog = createOperationLogger(meta);
	return storage.run(opLog, async () => {
		try {
			return await fn();
		} catch (e) {
			opLog.error(e instanceof Error ? e : new Error(String(e)));
			throw e;
		} finally {
			try {
				await emitPrepared(opLog);
			} catch {
				// Do not mask the error thrown from fn()
			}
		}
	});
}

export async function emitOperationLogger(
	logger: RequestLogger,
	overrides?: Record<string, unknown>,
): Promise<void> {
	await emitPrepared(logger, overrides);
}
