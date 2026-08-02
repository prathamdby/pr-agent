/** Runtime fields attached to every analytics exception capture. */
export type AnalyticsRuntimeContext = {
  readonly release?: string;
  readonly role?: "web" | "worker";
  readonly service?: string;
};

let runtimeContext: AnalyticsRuntimeContext = {};

export function setAnalyticsRuntimeContext(ctx: AnalyticsRuntimeContext): void {
  runtimeContext = { ...runtimeContext, ...ctx };
}

const SENSITIVE_KEY = /(?:password|secret|token|authorization|private[_-]?key|cookie|api[_-]?key)/i;

function redactAnalyticsProperties(
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

/** Merge boot context and redact secret-shaped keys for captureException. */
export function mergeExceptionProperties(
  properties?: Record<string, unknown>,
): Record<string, unknown> {
  const ctx = runtimeContext;
  const base: Record<string, unknown> = {
    service: ctx.service ?? "pr-agent",
    ...(ctx.role ? { role: ctx.role } : {}),
    ...(ctx.release ? { release: ctx.release, commit_sha: ctx.release } : {}),
  };
  const extra = redactAnalyticsProperties(properties);
  return extra ? { ...base, ...extra } : base;
}
