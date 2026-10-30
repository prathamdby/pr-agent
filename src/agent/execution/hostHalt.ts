import { errorMessage } from "../../errors/errorMessage.ts";
export const CODE_MODE_ERROR_CODES = [
  "SYNTAX_ERROR",
  "EXECUTION_BUDGET_EXCEEDED",
  "TIMEOUT",
  "CANCELLED",
  "LIMIT_EXCEEDED",
  "TOOL_FAILURE",
  "EXECUTION_ERROR",
] as const;

export type CodeModeErrorCode = (typeof CODE_MODE_ERROR_CODES)[number];

export function isCodeModeErrorCode(value: string): value is CodeModeErrorCode {
  return (CODE_MODE_ERROR_CODES as readonly string[]).includes(value);
}

export const CODE_MODE_HOST_CANCEL_MESSAGE = "Code Mode cancelled by host signal";

export const CODE_MODE_CAP_REASONS = [
  "workspace_calls",
  "pool_queue",
  "pool_wait",
  "cell_wall",
  "guest_cpu",
  "source_bytes",
  "state_bytes",
  "allocation",
] as const;

export type CodeModeCapReason = (typeof CODE_MODE_CAP_REASONS)[number];

export function isCodeModeCapReason(value: string): value is CodeModeCapReason {
  return (CODE_MODE_CAP_REASONS as readonly string[]).includes(value);
}

export function emptyCodeModeCapHits(): Record<CodeModeCapReason, number> {
  return {
    workspace_calls: 0,
    pool_queue: 0,
    pool_wait: 0,
    cell_wall: 0,
    guest_cpu: 0,
    source_bytes: 0,
    state_bytes: 0,
    allocation: 0,
  };
}

export function hostCancelHalt(): CodeModeHostHalt {
  return new CodeModeHostHalt("CANCELLED", CODE_MODE_HOST_CANCEL_MESSAGE);
}

export class CodeModeHostHalt extends Error {
  readonly code: CodeModeErrorCode;
  readonly line?: number;
  readonly reason?: CodeModeCapReason;

  constructor(
    code: CodeModeErrorCode,
    message: string,
    extra?: { readonly line?: number; readonly reason?: CodeModeCapReason },
  ) {
    super(message);
    this.name = "CodeModeHostHalt";
    this.code = code;
    if (extra?.line !== undefined) this.line = extra.line;
    if (extra?.reason !== undefined) this.reason = extra.reason;
  }
}

export function isCodeModeHostHalt(error: unknown): error is CodeModeHostHalt {
  return error instanceof CodeModeHostHalt;
}

export type CodeModeHostHaltPayload = {
  readonly code: CodeModeErrorCode;
  readonly message: string;
  readonly line?: number;
  readonly reason?: CodeModeCapReason;
};

export type EncodedHostCallFailure = {
  readonly ok: false;
  readonly halt?: CodeModeHostHaltPayload;
  readonly error?: string;
};

export function encodeHostCallFailure(error: unknown): EncodedHostCallFailure {
  if (isCodeModeHostHalt(error)) {
    return {
      ok: false,
      halt: {
        code: error.code,
        message: error.message,
        ...(error.line !== undefined ? { line: error.line } : {}),
        ...(error.reason !== undefined ? { reason: error.reason } : {}),
      },
    };
  }
  return {
    ok: false,
    error: errorMessage(error),
  };
}

export function decodeHostCallFailure(message: {
  readonly halt?: {
    readonly code: string;
    readonly message: string;
    readonly line?: number;
    readonly reason?: string;
  };
  readonly error?: string;
}): unknown {
  if (message.halt) {
    const code = isCodeModeErrorCode(message.halt.code) ? message.halt.code : "EXECUTION_ERROR";
    const reason =
      message.halt.reason != null && isCodeModeCapReason(message.halt.reason)
        ? message.halt.reason
        : undefined;
    return new CodeModeHostHalt(code, message.halt.message, {
      ...(message.halt.line !== undefined ? { line: message.halt.line } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return new Error(message.error ?? "host call failed");
}
