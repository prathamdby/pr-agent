/** Shared context fields attached to analytics exception captures. */
export type AnalyticsRuntimeContext = {
  readonly release?: string;
  readonly role?: "web" | "worker";
  readonly service?: string;
};

let runtimeContext: AnalyticsRuntimeContext = {};

export function setAnalyticsRuntimeContext(ctx: AnalyticsRuntimeContext): void {
  runtimeContext = { ...runtimeContext, ...ctx };
}

export function getAnalyticsRuntimeContext(): AnalyticsRuntimeContext {
  return runtimeContext;
}

const SENSITIVE_KEY = /(?:password|secret|token|authorization|private[_-]?key|cookie|api[_-]?key)/i;

/** Drop or redact sensitive keys before PostHog capture. */
export function redactAnalyticsProperties(
  properties?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!properties) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function mergeExceptionProperties(
  properties?: Record<string, unknown>,
): Record<string, unknown> {
  const ctx = getAnalyticsRuntimeContext();
  const release =
    ctx.release ??
    process.env.GITHUB_SHA?.slice(0, 12) ??
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
    process.env.COMMIT_SHA?.slice(0, 12) ??
    undefined;
  const base: Record<string, unknown> = {
    service: ctx.service ?? "pr-agent",
    ...(ctx.role ? { role: ctx.role } : {}),
    ...(release ? { release, commit_sha: release } : {}),
  };
  const extra = redactAnalyticsProperties(properties);
  return extra ? { ...base, ...extra } : base;
}
