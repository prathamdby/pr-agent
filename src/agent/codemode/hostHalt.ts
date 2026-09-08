import type { CodeModeErrorCode } from "./result.js";

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
