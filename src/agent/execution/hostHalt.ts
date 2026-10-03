import { errorMessage } from "../../errors/errorMessage.js";
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

export function hostCancelHalt(): CodeModeHostHalt {
  return new CodeModeHostHalt("CANCELLED", CODE_MODE_HOST_CANCEL_MESSAGE);
}

export class CodeModeHostHalt extends Error {
  readonly code: CodeModeErrorCode;
  readonly line?: number;

  constructor(code: CodeModeErrorCode, message: string, line?: number) {
    super(message);
    this.name = "CodeModeHostHalt";
    this.code = code;
    if (line !== undefined) this.line = line;
  }
}

export function isCodeModeHostHalt(error: unknown): error is CodeModeHostHalt {
  return error instanceof CodeModeHostHalt;
}

export type CodeModeHostHaltPayload = {
  readonly code: CodeModeErrorCode;
  readonly message: string;
  readonly line?: number;
};

export type EncodedHostCallFailure = {
  readonly ok: false;
  readonly halt?: CodeModeHostHaltPayload;
  readonly error?: string;
};

/** Structured worker-thread payload. `instanceof` does not survive `postMessage`. */
export function encodeHostCallFailure(error: unknown): EncodedHostCallFailure {
  if (isCodeModeHostHalt(error)) {
    return {
      ok: false,
      halt: {
        code: error.code,
        message: error.message,
        ...(error.line !== undefined ? { line: error.line } : {}),
      },
    };
  }
  return {
    ok: false,
    error: errorMessage(error),
  };
}

export function decodeHostCallFailure(message: {
  readonly halt?: { readonly code: string; readonly message: string; readonly line?: number };
  readonly error?: string;
}): unknown {
  if (message.halt) {
    const code = isCodeModeErrorCode(message.halt.code) ? message.halt.code : "EXECUTION_ERROR";
    return new CodeModeHostHalt(code, message.halt.message, message.halt.line);
  }
  return new Error(message.error ?? "host call failed");
}
