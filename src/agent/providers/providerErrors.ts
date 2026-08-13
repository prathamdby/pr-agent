export type ProviderErrorKind = "auth" | "quota" | "billing" | "rate_limit" | "timeout" | "unknown";

/** Logs-only classification for worker/provider failures. */
export function classifyProviderError(error: Error): ProviderErrorKind {
  const text = `${error.name} ${error.message}`.toLowerCase();
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
