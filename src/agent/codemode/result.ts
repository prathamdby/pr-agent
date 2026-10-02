import type { CodeModeErrorCode } from "../execution/hostHalt.js";

export type CodeModeToolCallStatus = "completed" | "error";

export type CodeModeToolCall = {
  readonly tool: string;
  readonly status: CodeModeToolCallStatus;
  readonly input?: unknown;
};

export type CodeModeSuccess = {
  readonly ok: true;
  readonly output: unknown;
  readonly toolCalls: ReadonlyArray<CodeModeToolCall>;
  readonly warnings?: ReadonlyArray<string>;
};

export type CodeModeFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: CodeModeErrorCode;
    readonly message: string;
    readonly line?: number;
  };
  readonly toolCalls: ReadonlyArray<Pick<CodeModeToolCall, "tool" | "status">>;
};

export type CodeModeResult = CodeModeSuccess | CodeModeFailure;

export type CodeModeInnerFailureKind =
  | "ACCESS_DENIED"
  | "FILE_NOT_FOUND"
  | "SEARCH_TRUNCATED"
  | "TOOL_INPUT_INVALID";
