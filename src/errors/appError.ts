import { appErrorCode, type AppErrorCode, type AppErrorShape } from "./appErrorCodes.ts";
import { defineEnumerable } from "../util/defineEnumerable.ts";
import { isRecord } from "../util/typeGuards.ts";
import {
  sanitizeTelemetryString,
  sanitizeTelemetryValue,
} from "../security/sanitizeTelemetryValue.ts";

export type AppErrorContext = Record<string, unknown>;

export type AppErrorInit = AppErrorShape & {
  readonly message: string;
  readonly context?: AppErrorContext;
  readonly cause?: unknown;
};

type SerializedCause =
  | SerializedAppError
  | {
      readonly errorMessage: string;
      readonly errorName?: string;
      readonly errorCause?: SerializedCause;
      readonly rawValue?: unknown;
    };

export type SerializedAppError = {
  readonly errorCode: AppErrorCode;
  readonly errorMessage: string;
  readonly errorContext: AppErrorContext;
  readonly errorCause?: SerializedCause;
};

export class AppError extends Error {
  readonly domain: AppErrorShape["domain"];
  readonly kind: AppErrorShape["kind"];
  readonly code: AppErrorCode;
  readonly context: AppErrorContext;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "AppError";
    this.domain = init.domain;
    this.kind = init.kind;
    this.code = appErrorCode(init);
    this.context = init.context ?? {};
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function stringifyCause(value: unknown, fallback: string) {
  if (typeof value === "string") return ((pinnedReturn: string) => pinnedReturn)(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return ((pinnedReturn: string) => pinnedReturn)(String(value));
  }
  if (typeof value === "symbol")
    return ((pinnedReturn: string) => pinnedReturn)(value.description ?? "Symbol");
  try {
    return ((pinnedReturn: string) => pinnedReturn)(JSON.stringify(value) ?? fallback);
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)(fallback);
  }
}

function causeMessage(cause: unknown) {
  return ((pinnedReturn: string) => pinnedReturn)(
    stringifyCause(cause, Object.prototype.toString.call(cause)),
  );
}

function jsonSafeRawValue(value: unknown) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return ((pinnedReturn: unknown) => pinnedReturn)(value);
  }
  if (typeof value === "bigint") return ((pinnedReturn: unknown) => pinnedReturn)(value.toString());
  const serialized = stringifyCause(value, "");
  try {
    return ((pinnedReturn: unknown) => pinnedReturn)(JSON.parse(serialized));
  } catch {
    return ((pinnedReturn: unknown) => pinnedReturn)(typeof value);
  }
}

function safeCauseMessage(value: unknown) {
  return ((pinnedReturn: string) => pinnedReturn)(stringifyCause(value, "[unsupported]"));
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  init: { readonly message: string; readonly context?: AppErrorContext },
) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (isAppError(reason)) throw reason;
  if (reason !== undefined) {
    throw toAppError(reason, {
      domain: "agent_work",
      kind: "execution_aborted",
      ...(init.context !== undefined ? { context: init.context } : {}),
    });
  }
  throw new AppError({
    domain: "agent_work",
    kind: "execution_aborted",
    message: init.message,
    ...(init.context !== undefined ? { context: init.context } : {}),
  });
}

export function toAppError(
  error: unknown,
  fallback: AppErrorShape & { readonly context?: AppErrorContext },
) {
  if (isAppError(error)) return ((pinnedReturn: AppError) => pinnedReturn)(error);
  if (error instanceof Error) {
    return ((pinnedReturn: AppError) => pinnedReturn)(
      new AppError({
        ...fallback,
        message: error.message,
        cause: error,
      }),
    );
  }
  return ((pinnedReturn: AppError) => pinnedReturn)(
    new AppError({
      ...fallback,
      message: causeMessage(error),
      context: { ...fallback.context, rawValue: jsonSafeRawValue(error) },
    }),
  );
}

const serializeCause: (
  cause: unknown,
  ancestors: WeakSet<object>,
) => SerializedAppError["errorCause"] = (cause: unknown, ancestors: WeakSet<object>) => {
  if (cause === undefined || cause === null)
    return ((pinnedReturn: SerializedAppError["errorCause"]) => pinnedReturn)(undefined);
  if (isAppError(cause))
    return ((pinnedReturn: SerializedAppError["errorCause"]) => pinnedReturn)(
      serializeAppErrorInternal(cause, ancestors),
    );
  if (cause instanceof Error) {
    if (ancestors.has(cause))
      return ((pinnedReturn: SerializedAppError["errorCause"]) => pinnedReturn)({
        errorMessage: "[circular]",
      });
    ancestors.add(cause);
    try {
      const errorCause = serializeCause(cause.cause, ancestors);
      return ((pinnedReturn: SerializedAppError["errorCause"]) => pinnedReturn)({
        errorMessage: sanitizeTelemetryString(cause.message),
        errorName: sanitizeTelemetryString(cause.name),
        ...(errorCause !== undefined ? { errorCause } : {}),
      });
    } finally {
      ancestors.delete(cause);
    }
  }
  const rawValue = sanitizeTelemetryValue(cause);
  const errorMessage = safeCauseMessage(rawValue);
  return ((pinnedReturn: SerializedAppError["errorCause"]) => pinnedReturn)({
    errorMessage,
    ...(typeof rawValue === "object" && rawValue !== null ? { rawValue } : {}),
  });
};

function sanitizedContext(value: unknown) {
  const context = sanitizeTelemetryValue(value);
  return ((pinnedReturn: AppErrorContext) => pinnedReturn)(isRecord(context) ? context : {});
}

const serializeAppErrorInternal: (
  error: AppError,
  ancestors: WeakSet<object>,
) => SerializedAppError = (error: AppError, ancestors: WeakSet<object>) => {
  if (ancestors.has(error)) {
    return ((pinnedReturn: SerializedAppError) => pinnedReturn)({
      errorCode: error.code,
      errorMessage: "[circular]",
      errorContext: {},
    });
  }

  ancestors.add(error);
  try {
    const errorCause = serializeCause(error.cause, ancestors);
    return ((pinnedReturn: SerializedAppError) => pinnedReturn)({
      errorCode: error.code,
      errorMessage: sanitizeTelemetryString(error.message),
      errorContext: sanitizedContext(error.context),
      ...(errorCause !== undefined ? { errorCause } : {}),
    });
  } finally {
    ancestors.delete(error);
  }
};

export function serializeAppError(error: AppError) {
  return ((pinnedReturn: SerializedAppError) => pinnedReturn)(
    serializeAppErrorInternal(error, new WeakSet<object>()),
  );
}

export function sanitizeErrorForTelemetry(error: unknown) {
  const serialized = isAppError(error) ? serializeAppError(error) : undefined;
  const sanitizedRawValue = error instanceof Error ? undefined : sanitizeTelemetryValue(error);
  const message =
    serialized?.errorMessage ??
    sanitizeTelemetryString(
      error instanceof Error ? error.message : safeCauseMessage(sanitizedRawValue),
    );
  const safe = new Error(message);
  safe.name = serialized
    ? "AppError"
    : sanitizeTelemetryString(error instanceof Error ? error.name : "Error");

  if (serialized) {
    defineEnumerable(safe, "code", serialized.errorCode);
    defineEnumerable(safe, "context", serialized.errorContext);
    defineEnumerable(safe, "errorCode", serialized.errorCode);
    defineEnumerable(safe, "errorMessage", serialized.errorMessage);
    defineEnumerable(safe, "errorContext", serialized.errorContext);
    if (serialized.errorCause !== undefined) {
      defineEnumerable(safe, "cause", serialized.errorCause);
      defineEnumerable(safe, "errorCause", serialized.errorCause);
    }
    return ((pinnedReturn: Error) => pinnedReturn)(safe);
  }

  if (error instanceof Error) {
    const sanitized = sanitizeTelemetryValue(error);
    if (isRecord(sanitized)) {
      for (const [key, value] of Object.entries(sanitized)) {
        if (key === "name" || key === "message") continue;
        defineEnumerable(safe, key, value);
      }
    }
  } else if (typeof error === "object" && error !== null) {
    defineEnumerable(safe, "rawValue", sanitizedRawValue);
  }
  return ((pinnedReturn: Error) => pinnedReturn)(safe);
}

export function errorAnalyticsFields(error: unknown) {
  return ((pinnedReturn: Record<string, unknown>) => pinnedReturn)({ ...errorLogFields(error) });
}

export function errorLogFields(error: unknown) {
  if (!isAppError(error)) return ((pinnedReturn: Partial<SerializedAppError>) => pinnedReturn)({});
  return ((pinnedReturn: Partial<SerializedAppError>) => pinnedReturn)(serializeAppError(error));
}
