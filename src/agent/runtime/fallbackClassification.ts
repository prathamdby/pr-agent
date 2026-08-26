import { isAppError } from "../../errors/appError.js";
import { classifyProviderError } from "../providers/providerErrors.js";

/** Failures that may activate the shared fallback model after retry exhaustion. */
export type FallbackEligibleReason =
  | "transport"
  | "rate_limit"
  | "provider_5xx"
  | "model_unavailable";

/** Failures that must stay on existing paths and never trigger fallback. */
export type FallbackIneligibleReason =
  | "auth"
  | "config"
  | "invalid_request"
  | "context_limit"
  | "tool"
  | "validation"
  | "internal"
  | "cancellation"
  | "deadline";

export type FallbackClassification =
  | { readonly eligible: true; readonly reason: FallbackEligibleReason }
  | { readonly eligible: false; readonly reason: FallbackIneligibleReason };

function textOf(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLowerCase();
  return String(error).toLowerCase();
}

function codeOf(error: unknown): string | undefined {
  return isAppError(error) ? error.code.toLowerCase() : undefined;
}

function isCancellationFailure(text: string, code: string): boolean {
  return (
    /cancelled|canceled|superseded|aborted/.test(text) ||
    code.includes("cancel") ||
    code.includes("abort")
  );
}

function isDeadlineFailure(text: string, code: string): boolean {
  return (
    /deadline|timed out|timeout|idle_timeout|wall.?clock/.test(text) ||
    code.includes("timeout") ||
    code.includes("deadline")
  );
}

function isContextLimitFailure(text: string, code: string): boolean {
  return (
    /context.?length|context.?window|maximum context|token limit|too many tokens|prompt is too long/.test(
      text,
    ) || code.includes("context_limit")
  );
}

function isInvalidRequestOrValidationFailure(
  text: string,
  code: string,
): Extract<FallbackClassification, { eligible: false }> | null {
  if (
    !/invalid.?request|invalid_request|schema|json parse|tool.?parameter/.test(text) &&
    !code.includes("invalid_request") &&
    !code.includes("validation")
  ) {
    return null;
  }
  if (code.includes("validation") || /schema|validation/.test(text)) {
    return { eligible: false, reason: "validation" };
  }
  return { eligible: false, reason: "invalid_request" };
}

function isToolFailure(text: string, code: string): boolean {
  return /tool|executor/.test(code) || /missing_tool_executor|tool_call/.test(text);
}

function isConfigFailure(text: string, code: string): boolean {
  return /config\.|settings\./.test(code) || /misconfigured|configuration/.test(text);
}

function isInternalFailure(text: string, code: string): boolean {
  return /internal|bug|invariant/.test(code) || /internal error/.test(text);
}

function isProvider5xxFailure(text: string): boolean {
  return /\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout/.test(
    text,
  );
}

function isModelUnavailableFailure(text: string, code: string): boolean {
  return (
    /model.?unavailable|model not found|model_not_found|does not exist|not currently available|capacity/.test(
      text,
    ) ||
    code.includes("model_not_found") ||
    code.includes("model_unavailable")
  );
}

function isTransportFailure(text: string, code: string): boolean {
  return (
    /econnreset|econnrefused|etimedout|socket hang up|network|fetch failed|transport|connection reset/.test(
      text,
    ) || code.includes("transport")
  );
}

/**
 * Classify whether a session failure may start fallback recovery.
 * Call only after the normal retry budget for the primary model is exhausted.
 */
export function classifyFallbackEligibility(error: unknown): FallbackClassification {
  const text = textOf(error);
  const code = codeOf(error) ?? "";

  if (isCancellationFailure(text, code)) {
    return { eligible: false, reason: "cancellation" };
  }
  if (isDeadlineFailure(text, code)) {
    return { eligible: false, reason: "deadline" };
  }
  if (isContextLimitFailure(text, code)) {
    return { eligible: false, reason: "context_limit" };
  }
  const invalidRequest = isInvalidRequestOrValidationFailure(text, code);
  if (invalidRequest) return invalidRequest;
  if (isToolFailure(text, code)) {
    return { eligible: false, reason: "tool" };
  }
  if (isConfigFailure(text, code)) {
    return { eligible: false, reason: "config" };
  }
  if (isInternalFailure(text, code)) {
    return { eligible: false, reason: "internal" };
  }

  const providerKind = classifyProviderError(error);
  if (providerKind === "auth") {
    return { eligible: false, reason: "auth" };
  }
  if (providerKind === "rate_limit") {
    return { eligible: true, reason: "rate_limit" };
  }
  if (isProvider5xxFailure(text)) {
    return { eligible: true, reason: "provider_5xx" };
  }
  if (isModelUnavailableFailure(text, code)) {
    return { eligible: true, reason: "model_unavailable" };
  }
  if (isTransportFailure(text, code)) {
    return { eligible: true, reason: "transport" };
  }

  // Default: do not hide unknown defects behind fallback.
  return { eligible: false, reason: "internal" };
}
