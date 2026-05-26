export const CURSOR_STARTUP_ERROR_PREFIX = "cursor_startup_error:";
export const CURSOR_RUN_ERROR_PREFIX = "cursor_run_error:";

export type CursorStartupErrorLike = Error & {
  readonly isRetryable?: boolean;
};

export function isCursorStartupErrorLike(err: unknown): err is CursorStartupErrorLike {
  return err instanceof Error && err.name === "CursorAgentError";
}

export function formatCursorStartupError(err: CursorStartupErrorLike): string {
  const retryable = err.isRetryable ? " retryable=true" : " retryable=false";
  return `${CURSOR_STARTUP_ERROR_PREFIX} ${err.message}${retryable}`;
}

export function formatCursorRunError(runId: string): string {
  return `${CURSOR_RUN_ERROR_PREFIX} ${runId}`;
}

export function isCursorStartupError(message: string | undefined): boolean {
  return message?.startsWith(CURSOR_STARTUP_ERROR_PREFIX) ?? false;
}

export function isCursorRunError(message: string | undefined): boolean {
  return message?.startsWith(CURSOR_RUN_ERROR_PREFIX) ?? false;
}
