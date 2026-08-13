import {
  createRequestLogger,
  initLogger,
  log as globalLog,
  type AuditableLogger,
  type RequestLogger,
  withAuditMethods,
} from "evlog";
import { createLoggerStorage } from "evlog/toolkit";
import { captureException, isAnalyticsEnabled } from "./analytics/index.js";
import type { Config } from "./config.js";
import * as v from "valibot";
import { nonErrorThrown } from "./errors/appError.js";
import {
  isJsonNumber,
  isJsonString,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "./util/jsonValue.js";

export type { RequestLogger };

export type WideEventLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} satisfies Record<WideEventLevel, number>;

import { LOG_MAX_WIDE_EVENTS } from "./settings/index.js";

const DEFAULT_MAX_WIDE_EVENTS = LOG_MAX_WIDE_EVENTS;

const NODE_ENV_SCHEMA = v.picklist(["development", "production", "test"]);

let globalMinLevel: WideEventLevel = "info";
let globalMaxWideEvents = DEFAULT_MAX_WIDE_EVENTS;

const { storage, useLogger: useLoggerFromStorage } = createLoggerStorage(
  "evlog: call initEvlog() at boot and run handlers inside runWithOperationLogger()",
);

export function isLevelEnabled(level: WideEventLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[globalMinLevel];
}

export function tryUseLogger(): RequestLogger | undefined {
  try {
    return useLoggerFromStorage();
  } catch {
    return undefined;
  }
}

function isWideEventLevel(value: JsonValue | undefined): value is WideEventLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

function eventsArray(logger: RequestLogger): JsonObject[] {
  const current = logger.getContext().events;
  // Mutate the context array in place. logger.set({ events: clone }) concatenates
  // under evlog's merge and doubles the list on every append.
  if (Array.isArray(current) && current.every((item) => v.is(jsonObjectSchema, item))) {
    return current;
  }
  const events: JsonObject[] = [];
  logger.set({ events });
  return events;
}

function filterEventsInPlace(logger: RequestLogger): void {
  const events = eventsArray(logger);
  let write = 0;
  for (const entry of events) {
    const level = isWideEventLevel(entry.level) ? entry.level : "info";
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
  fields?: JsonObject,
  level: WideEventLevel = "info",
): void {
  if (!isLevelEnabled(level)) return;

  const events = eventsArray(logger);
  const droppedParsed = v.safeParse(v.number(), logger.getContext().eventsDropped);
  const dropped = droppedParsed.success ? droppedParsed.output : 0;

  if (events.length >= globalMaxWideEvents) {
    logger.set({ eventsDropped: dropped + 1, lastEvent: "events_truncated" });
    return;
  }

  if (fields === undefined) {
    events.push({ event, level, at: Date.now() });
  } else {
    events.push({ event, level, ...fields, at: Date.now() });
  }
  logger.set({ lastEvent: event });
}

function recordOrGlobal(
  level: WideEventLevel,
  globalFn: (payload: JsonObject) => void,
  event: string,
  meta?: JsonObject,
): void {
  const logger = tryUseLogger();
  if (logger) {
    recordEvent(logger, event, meta, level);
    return;
  }
  if (!isLevelEnabled(level)) return;
  if (meta === undefined) {
    globalFn({ event });
  } else {
    globalFn({ event, ...meta });
  }
}

export function logDebug(event: string, meta?: JsonObject): void {
  recordOrGlobal("debug", (p) => globalLog.debug(p), event, meta);
}

export function logInfo(event: string, meta?: JsonObject): void {
  recordOrGlobal("info", (p) => globalLog.info(p), event, meta);
}

export function logWarn(event: string, meta?: JsonObject): void {
  recordOrGlobal("warn", (p) => globalLog.warn(p), event, meta);
}

function analyticsDistinctIdFromMeta(meta?: JsonObject): string {
  if (meta == null) return "server";
  if (isJsonString(meta.analyticsDistinctId) && meta.analyticsDistinctId.length > 0) {
    return meta.analyticsDistinctId;
  }
  if (isJsonNumber(meta.installationId)) {
    return `installation:${meta.installationId}`;
  }
  if (isJsonString(meta.installationId) && meta.installationId.length > 0) {
    return `installation:${meta.installationId}`;
  }
  return "server";
}

function errorFromLogErrorArgs(event: string, meta?: JsonObject, error?: Error | string): Error {
  if (error instanceof Error) return error;
  if (error !== undefined) return new Error(error);
  if (isJsonString(meta?.message) && meta.message.length > 0) {
    return new Error(meta.message);
  }
  return new Error(event);
}

function forwardLogErrorToAnalytics(
  event: string,
  meta?: JsonObject,
  error?: Error | string,
): void {
  if (!isAnalyticsEnabled()) return;

  const properties: JsonObject = Object.fromEntries([
    ["event", event],
    ...Object.entries(meta ?? {})
      .filter(([key]) => key !== "analyticsDistinctId" && key !== "error" && key !== "err")
      .flatMap(([key, value]) => {
        const parsed = v.safeParse(jsonValueSchema, value);
        return parsed.success ? [[key, parsed.output] as const] : [];
      }),
  ]);

  captureException(
    errorFromLogErrorArgs(event, meta, error),
    analyticsDistinctIdFromMeta(meta),
    properties,
  );
}

export function logError(event: string, meta?: JsonObject, error?: Error | string): void {
  recordOrGlobal("error", (p) => globalLog.error(p), event, meta);
  forwardLogErrorToAnalytics(event, meta, error);
}

export type OperationLoggerMeta = {
  readonly method: string;
  readonly path: string;
  readonly requestId?: string;
  readonly context?: JsonObject;
};

function parseNodeEnv(value: string): "development" | "production" | "test" {
  const parsed = v.safeParse(NODE_ENV_SCHEMA, value);
  return parsed.success ? parsed.output : "development";
}

export function initEvlog(
  logLevel: Config["logLevel"],
  options?: {
    silent?: boolean;
    suppressDrainWarning?: boolean;
    maxWideEvents?: number;
    pretty?: boolean;
    redact?: boolean;
  },
): void {
  globalMinLevel = logLevel;
  globalMaxWideEvents = options?.maxWideEvents ?? DEFAULT_MAX_WIDE_EVENTS;

  const isProduction = process.env.NODE_ENV === "production";
  initLogger({
    env: {
      service: "pr-agent",
      environment: parseNodeEnv(process.env.NODE_ENV ?? "development"),
    },
    minLevel: logLevel,
    pretty: options?.pretty ?? !isProduction,
    redact: options?.redact ?? isProduction,
    silent: options?.silent ?? false,
    _suppressDrainWarning: options?.suppressDrainWarning ?? false,
  });
}

export function createOperationLogger(meta: OperationLoggerMeta): AuditableLogger {
  const logger = withAuditMethods(
    createRequestLogger({
      method: meta.method,
      path: meta.path,
      requestId: meta.requestId,
    }),
  );
  if (meta.context) logger.set(meta.context);
  return logger;
}

async function emitPrepared(logger: RequestLogger, overrides?: JsonObject): Promise<void> {
  filterEventsInPlace(logger);
  logger.set({ emitted: true });
  await Promise.resolve(logger.emit(overrides));
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
      opLog.error(e instanceof Error ? e : nonErrorThrown("evlog.operation_non_error_thrown"));
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
  overrides?: JsonObject,
): Promise<void> {
  await emitPrepared(logger, overrides);
}
