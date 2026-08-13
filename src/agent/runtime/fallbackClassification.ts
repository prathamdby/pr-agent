import { AppError } from "../../errors/appError.js";
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

function textOf(error: Error): string {
  return `${error.name} ${error.message}`.toLowerCase();
}

function codeOf(error: Error): string | undefined {
  return error instanceof AppError ? error.code.toLowerCase() : undefined;
}

/**
 * Classify whether a session failure may start fallback recovery.
 * Call only after the normal retry budget for the primary model is exhausted.
 */
export function classifyFallbackEligibility(error: Error): FallbackClassification {
  const text = textOf(error);
  const code = codeOf(error) ?? "";

  if (
    /cancelled|canceled|superseded|aborted/.test(text) ||
    code.includes("cancel") ||
    code.includes("abort")
  ) {
    return { eligible: false, reason: "cancellation" };
  }

  if (
    /deadline|timed out|timeout|idle_timeout|wall.?clock/.test(text) ||
    code.includes("timeout") ||
    code.includes("deadline")
  ) {
    return { eligible: false, reason: "deadline" };
  }

  if (
    /context.?length|context.?window|maximum context|token limit|too many tokens|prompt is too long/.test(
      text,
    ) ||
    code.includes("context_limit")
  ) {
    return { eligible: false, reason: "context_limit" };
  }

  if (
    /invalid.?request|invalid_request|schema|json parse|tool.?parameter/.test(text) ||
    code.includes("invalid_request") ||
    code.includes("validation")
  ) {
    if (code.includes("validation") || /schema|validation/.test(text)) {
      return { eligible: false, reason: "validation" };
    }
    return { eligible: false, reason: "invalid_request" };
  }

  if (/tool|executor/.test(code) || /missing_tool_executor|tool_call/.test(text)) {
    return { eligible: false, reason: "tool" };
  }

  if (/config\.|settings\./.test(code) || /misconfigured|configuration/.test(text)) {
    return { eligible: false, reason: "config" };
  }

  if (/internal|bug|invariant/.test(code) || /internal error/.test(text)) {
    return { eligible: false, reason: "internal" };
  }

  const providerKind = classifyProviderError(error);
  if (providerKind === "auth") {
    return { eligible: false, reason: "auth" };
  }
  if (providerKind === "rate_limit") {
    return { eligible: true, reason: "rate_limit" };
  }

  if (
    /\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout/.test(text)
  ) {
    return { eligible: true, reason: "provider_5xx" };
  }

  if (
    /model.?unavailable|model not found|model_not_found|does not exist|not currently available|capacity/.test(
      text,
    ) ||
    code.includes("model_not_found") ||
    code.includes("model_unavailable")
  ) {
    return { eligible: true, reason: "model_unavailable" };
  }

  if (
    /econnreset|econnrefused|etimedout|socket hang up|network|fetch failed|transport|connection reset/.test(
      text,
    ) ||
    code.includes("transport")
  ) {
    return { eligible: true, reason: "transport" };
  }

  return { eligible: false, reason: "internal" };
}
