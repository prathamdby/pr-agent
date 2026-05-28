export type ProviderErrorKind =
  | "auth"
  | "quota"
  | "billing"
  | "rate_limit"
  | "timeout"
  | "unknown";

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

/** Logs-only classification for worker/provider failures. */
export function classifyProviderError(error: unknown): ProviderErrorKind {
  const text = errorText(error);
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
  if (/quota|insufficient credits|usage limit|token limit exceeded/.test(text)) {
    return "quota";
  }
  if (/billing|payment required|subscription|plan limit/.test(text)) {
    return "billing";
  }
  if (/timeout|timed out|deadline exceeded|hang|stalled/.test(text)) {
    return "timeout";
  }
  return "unknown";
}
