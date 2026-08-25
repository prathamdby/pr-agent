import {
  sanitizeTelemetryString,
  sanitizeTelemetryValue,
} from "../security/sanitizeTelemetryValue.js";

export type AppErrorContext = Record<string, unknown>;

export type AppErrorInit = {
  readonly code: string;
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
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorContext: AppErrorContext;
  readonly errorCause?: SerializedCause;
};

/** Internal structured failure. Never use `.message` on PR-facing surfaces. */
export class AppError extends Error {
  readonly code: string;
  readonly context: AppErrorContext;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "AppError";
    this.code = init.code;
    this.context = init.context ?? {};
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function stringifyCause(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.description ?? "Symbol";
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function causeMessage(cause: unknown): string {
  return stringifyCause(cause, Object.prototype.toString.call(cause));
}

function jsonSafeRawValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  const serialized = stringifyCause(value, "");
  try {
    return JSON.parse(serialized);
  } catch {
    return typeof value;
  }
}

function safeCauseMessage(value: unknown): string {
  return stringifyCause(value, "[unsupported]");
}

export function toAppError(
  error: unknown,
  fallback: { readonly code: string; readonly context?: AppErrorContext },
): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError({
      code: fallback.code,
      message: error.message,
      context: fallback.context,
      cause: error,
    });
  }
  return new AppError({
    code: fallback.code,
    message: causeMessage(error),
    context: { ...fallback.context, rawValue: jsonSafeRawValue(error) },
  });
}

function serializeCause(
  cause: unknown,
  ancestors: WeakSet<object>,
): SerializedAppError["errorCause"] {
  if (cause === undefined || cause === null) return undefined;
  if (isAppError(cause)) return serializeAppErrorInternal(cause, ancestors);
  if (cause instanceof Error) {
    if (ancestors.has(cause)) return { errorMessage: "[circular]" };
    ancestors.add(cause);
    try {
      const errorCause = serializeCause(cause.cause, ancestors);
      return {
        errorMessage: sanitizeTelemetryString(cause.message),
        errorName: sanitizeTelemetryString(cause.name),
        ...(errorCause !== undefined ? { errorCause } : {}),
      };
    } finally {
      ancestors.delete(cause);
    }
  }
  const rawValue = sanitizeTelemetryValue(cause);
  const errorMessage = safeCauseMessage(rawValue);
  return {
    errorMessage,
    ...(typeof rawValue === "object" && rawValue !== null ? { rawValue } : {}),
  };
}

function sanitizedContext(value: unknown): AppErrorContext {
  const context = sanitizeTelemetryValue(value);
  if (typeof context !== "object" || context === null || Array.isArray(context)) return {};
  return context as AppErrorContext;
}

function serializeAppErrorInternal(
  error: AppError,
  ancestors: WeakSet<object>,
): SerializedAppError {
  if (ancestors.has(error)) {
    return {
      errorCode: error.code,
      errorMessage: "[circular]",
      errorContext: {},
    };
  }

  ancestors.add(error);
  try {
    const errorCause = serializeCause(error.cause, ancestors);
    return {
      errorCode: error.code,
      errorMessage: sanitizeTelemetryString(error.message),
      errorContext: sanitizedContext(error.context),
      ...(errorCause !== undefined ? { errorCause } : {}),
    };
  } finally {
    ancestors.delete(error);
  }
}

export function serializeAppError(error: AppError): SerializedAppError {
  return serializeAppErrorInternal(error, new WeakSet<object>());
}

function setSafeProperty(target: Error, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Create an Error-shaped value whose message, cause, and custom fields are safe to forward. */
export function sanitizeErrorForTelemetry(error: unknown): Error {
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
    setSafeProperty(safe, "code", serialized.errorCode);
    setSafeProperty(safe, "context", serialized.errorContext);
    setSafeProperty(safe, "errorCode", serialized.errorCode);
    setSafeProperty(safe, "errorMessage", serialized.errorMessage);
    setSafeProperty(safe, "errorContext", serialized.errorContext);
    if (serialized.errorCause !== undefined) {
      setSafeProperty(safe, "cause", serialized.errorCause);
      setSafeProperty(safe, "errorCause", serialized.errorCause);
    }
    return safe;
  }

  if (error instanceof Error) {
    const sanitized = sanitizeTelemetryValue(error);
    if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
      for (const [key, value] of Object.entries(sanitized as Record<string, unknown>)) {
        if (key === "name" || key === "message") continue;
        setSafeProperty(safe, key, value);
      }
    }
  } else if (typeof error === "object" && error !== null) {
    setSafeProperty(safe, "rawValue", sanitizedRawValue);
  }
  return safe;
}

export function errorAnalyticsFields(error: unknown): Record<string, unknown> {
  return { ...errorLogFields(error) };
}

export function errorLogFields(error: unknown): Partial<SerializedAppError> {
  if (!isAppError(error)) return {};
  return serializeAppError(error);
}
