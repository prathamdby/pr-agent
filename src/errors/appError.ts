export type AppErrorContext = Record<string, unknown>;

export type AppErrorInit = {
  readonly code: string;
  readonly message: string;
  readonly context?: AppErrorContext;
  readonly cause?: unknown;
};

export type SerializedCause =
  | SerializedAppError
  | { readonly errorMessage: string; readonly errorName?: string };

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

function causeMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (typeof cause === "number" || typeof cause === "boolean" || typeof cause === "bigint") {
    return String(cause);
  }
  if (typeof cause === "symbol") return cause.description ?? "Symbol";
  try {
    return JSON.stringify(cause) ?? "null";
  } catch {
    return Object.prototype.toString.call(cause);
  }
}

/** JSON-safe snapshot of a non-Error throw value for context bags. */
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
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return typeof value;
  }
}

/** Wrap unknown values as AppError without losing an existing AppError. */
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

function serializeCause(cause: unknown): SerializedAppError["errorCause"] {
  if (cause === undefined || cause === null) return undefined;
  if (isAppError(cause)) return serializeAppError(cause);
  if (cause instanceof Error) {
    return { errorMessage: cause.message, errorName: cause.name };
  }
  return { errorMessage: causeMessage(cause) };
}

/** JSON-safe bag for logs (and later analytics sinks). */
export function serializeAppError(error: AppError): SerializedAppError {
  const errorCause = serializeCause(error.cause);
  return {
    errorCode: error.code,
    errorMessage: error.message,
    errorContext: error.context,
    ...(errorCause !== undefined ? { errorCause } : {}),
  };
}

/** Merge into logError meta; empty object when not an AppError. */
export function errorLogFields(error: unknown): Partial<SerializedAppError> {
  if (!isAppError(error)) return {};
  return serializeAppError(error);
}
