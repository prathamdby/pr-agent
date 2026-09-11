import { isAppError } from "../../errors/appError.js";

export type ProviderErrorKind =
  | "auth"
  | "quota"
  | "billing"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "unknown";

const CANCEL_ABORT_CODES = new Set(["agent.session_aborted", "review.specialist_aborted"]);

/** Host-signal or session abort. Not a provider timeout and not retryable. */
export function isCancelAbortError(error: unknown): boolean {
  if (isAppError(error) && CANCEL_ABORT_CODES.has(error.code)) return true;
  return (
    error instanceof Error &&
    error.name === "CodeModeHostHalt" &&
    "code" in error &&
    (error as { code: unknown }).code === "CANCELLED"
  );
}

/** Logs-only classification for worker/provider failures. */
export function classifyProviderError(error: unknown): ProviderErrorKind {
  if (isCancelAbortError(error)) return "cancelled";
  if (
    error instanceof Error &&
    error.name === "CodeModeHostHalt" &&
    "code" in error &&
    (error as { code: unknown }).code === "TIMEOUT"
  ) {
    return "timeout";
  }
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`.toLowerCase()
      : String(error).toLowerCase();
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication|bad credentials/.test(
      text,
    )
  ) {
    return "auth";
  }
  if (/\b429\b|rate limit|too many requests|secondary rate/.test(text)) {
    return "rate_limit";
  }
  if (/billing|payment required|payment_required|\b402\b|subscription|plan limit/.test(text)) {
    return "billing";
  }
  if (
    /quota|insufficient credits|out of credits|usage limit|token limit exceeded|\bcredits?\b|\bbalance\b/.test(
      text,
    )
  ) {
    return "quota";
  }
  if (/timeout|timed out|deadline exceeded|hang|stalled/.test(text)) {
    return "timeout";
  }
  return "unknown";
}
