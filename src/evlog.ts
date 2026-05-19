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

const { storage, useLogger: useLoggerFromStorage } = createLoggerStorage(
	"evlog: call initEvlog() at boot and run handlers inside runWithOperationLogger()",
);

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

/** Append a named sub-event while accumulating one wide event per operation. */
export function recordEvent(
	logger: RequestLogger,
	event: string,
	fields?: Record<string, unknown>,
): void {
	const ctx = logger.getContext();
	const events = Array.isArray(ctx.events)
		? [...(ctx.events as Array<Record<string, unknown>>)]
		: [];
	events.push({ event, ...(fields ?? {}), at: Date.now() });
	logger.set({
		events,
		lastEvent: event,
	});
}

export function logDebug(event: string, meta?: Record<string, unknown>): void {
	const logger = tryUseLogger();
	if (logger) {
		recordEvent(logger, event, meta);
		return;
	}
	globalLog.debug({ event, ...(meta ?? {}) });
}

export function logInfo(event: string, meta?: Record<string, unknown>): void {
	const logger = tryUseLogger();
	if (logger) {
		recordEvent(logger, event, meta);
		return;
	}
	globalLog.info({ event, ...(meta ?? {}) });
}

export function logWarn(event: string, meta?: Record<string, unknown>): void {
	const logger = tryUseLogger();
	if (logger) {
		recordEvent(logger, event, meta);
		return;
	}
	globalLog.warn({ event, ...(meta ?? {}) });
}

export function logError(event: string, meta?: Record<string, unknown>): void {
	const logger = tryUseLogger();
	if (logger) {
		recordEvent(logger, event, meta);
		return;
	}
	globalLog.error({ event, ...(meta ?? {}) });
}

export type OperationLoggerMeta = {
	readonly method: string;
	readonly path: string;
	readonly requestId?: string;
	readonly context?: Record<string, unknown>;
};

export function initEvlog(
	logLevel: Config["logLevel"],
	options?: { silent?: boolean; suppressDrainWarning?: boolean },
): void {
	initLogger({
		env: {
			service: "pr-agent",
			environment: (process.env.NODE_ENV ?? "development") as "development" | "production" | "test",
		},
		minLevel: logLevel,
		pretty: process.env.NODE_ENV !== "production",
		redact: process.env.NODE_ENV === "production",
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
			await opLog.emit();
		}
	});
}

export async function emitOperationLogger(
	logger: RequestLogger,
	overrides?: Record<string, unknown>,
): Promise<void> {
	logger.set({ emitted: true });
	await logger.emit(overrides);
}
