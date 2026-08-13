import * as v from "valibot";
import type { JsonObject } from "../util/jsonValue.js";

export type AppErrorContext = JsonObject;

export type AppErrorInit = {
  readonly code: string;
  readonly message: string;
  readonly context?: AppErrorContext;
  readonly cause?: Error;
};

type SerializedCause =
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

export function isAppError(error: Error): error is AppError {
  return error instanceof AppError;
}

export function nonErrorThrown(code: string, context?: AppErrorContext): AppError {
  return new AppError({ code, message: "Non-error thrown", context });
}

export function toAppError(
  error: Error,
  fallback: { readonly code: string; readonly context?: AppErrorContext },
): AppError {
  if (error instanceof AppError) return error;
  return new AppError({
    code: fallback.code,
    message: error.message,
    context: fallback.context,
    cause: error,
  });
}

function serializeCause(cause: Error): SerializedCause {
  if (cause instanceof AppError) return serializeAppError(cause);
  return { errorMessage: cause.message, errorName: cause.name };
}

export function serializeAppError(error: AppError): SerializedAppError {
  const cause = error.cause;
  const serialized: SerializedAppError = {
    errorCode: error.code,
    errorMessage: error.message,
    errorContext: error.context,
  };
  if (!(cause instanceof Error)) return serialized;
  return {
    errorCode: serialized.errorCode,
    errorMessage: serialized.errorMessage,
    errorContext: serialized.errorContext,
    errorCause: serializeCause(cause),
  };
}

export function errorLogFields(error: Error): Partial<SerializedAppError> {
  if (!(error instanceof AppError)) return {};
  return serializeAppError(error);
}

export function nodeErrorCode(error: Error): string | number | undefined {
  if (!("code" in error)) return undefined;
  const parsed = v.safeParse(v.union([v.string(), v.number()]), error.code);
  return parsed.success ? parsed.output : undefined;
}

export function nodeErrorStdout(error: Error): string {
  if (!("stdout" in error)) return "";
  const parsed = v.safeParse(v.string(), error.stdout);
  return parsed.success ? parsed.output : "";
}

export function nodeErrorStderr(error: Error): string {
  if (!("stderr" in error)) return "";
  const parsed = v.safeParse(v.string(), error.stderr);
  return parsed.success ? parsed.output : "";
}
