import { isAppError } from "../../errors/appError.ts";
import type { AppErrorCode } from "../../errors/appErrorCodes.ts";

export type ProviderErrorKind =
  | "auth"
  | "quota"
  | "billing"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "unknown";

const CANCEL_ABORT_CODES = new Set<AppErrorCode>([
  "agent.session_aborted",
  "review.specialist_aborted",
]);

export function isCancelAbortError(error: unknown) {
  if (isAppError(error) && CANCEL_ABORT_CODES.has(error.code))
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    error instanceof Error &&
      error.name === "CodeModeHostHalt" &&
      "code" in error &&
      (error as { code: unknown }).code === "CANCELLED",
  );
}

export function isProviderRefusalError(error: unknown) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    isAppError(error) && error.code === "provider.refusal",
  );
}

export function classifyProviderError(error: unknown) {
  if (isCancelAbortError(error))
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("cancelled");
  if (isAppError(error) && error.code === "review.specialist_timeout")
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("timeout");
  if (isAppError(error) && error.domain !== "provider")
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("unknown");
  if (
    error instanceof Error &&
    error.name === "CodeModeHostHalt" &&
    "code" in error &&
    (error as { code: unknown }).code === "TIMEOUT"
  ) {
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("timeout");
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
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("auth");
  }
  if (/\b429\b|rate limit|too many requests|secondary rate/.test(text)) {
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("rate_limit");
  }
  if (/billing|payment required|payment_required|\b402\b|subscription|plan limit/.test(text)) {
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("billing");
  }
  if (
    /quota|insufficient credits|out of credits|usage limit|token limit exceeded|\bcredits?\b|\bbalance\b/.test(
      text,
    )
  ) {
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("quota");
  }
  if (/timeout|timed out|deadline exceeded|hang|stalled/.test(text)) {
    return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("timeout");
  }
  return ((pinnedReturn: ProviderErrorKind) => pinnedReturn)("unknown");
}
