import { errorMessage } from "../../../errors/errorMessage.ts";

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

export function emptyCodeModeCapHits() {
  return ((pinnedReturn: Record<CodeModeCapReason, number>) => pinnedReturn)({
    workspace_calls: 0,
    pool_queue: 0,
    pool_wait: 0,
    cell_wall: 0,
    guest_cpu: 0,
    source_bytes: 0,
    state_bytes: 0,
    allocation: 0,
  });
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

export function codeModeHaltFromPayload(payload: {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly line?: unknown;
  readonly reason?: unknown;
}) {
  const code =
    typeof payload.code === "string" && isCodeModeErrorCode(payload.code)
      ? payload.code
      : "EXECUTION_ERROR";
  const message = typeof payload.message === "string" ? payload.message : "Code Mode halted";
  const extra: { line?: number; reason?: CodeModeCapReason } = {};
  if (typeof payload.line === "number") extra.line = payload.line;
  if (typeof payload.reason === "string" && isCodeModeCapReason(payload.reason))
    extra.reason = payload.reason;
  return ((pinnedReturn: CodeModeHostHalt) => pinnedReturn)(
    new CodeModeHostHalt(code, message, extra),
  );
}

export function codeModeHaltPayload(error: unknown) {
  if (!isCodeModeHostHalt(error))
    return ((pinnedReturn: { code: string; message: string }) => pinnedReturn)({
      code: "EXECUTION_ERROR",
      message: errorMessage(error),
    });
  return ((pinnedReturn: { code: string; message: string; line?: number; reason?: string }) =>
    pinnedReturn)({
    code: error.code,
    message: error.message,
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.reason !== undefined ? { reason: error.reason } : {}),
  });
}
