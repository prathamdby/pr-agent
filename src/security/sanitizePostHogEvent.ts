import { redactOutboundSecrets } from "./redactOutboundSecrets.js";

/** Structural subset of posthog-node EventMessage used by before_send (no SDK import). */
export type PostHogEventMessage = {
  readonly properties?: Record<string | number, unknown> | null;
  readonly [key: string]: unknown;
};

const STACK_FRAME_STRING_KEYS = [
  "filename",
  "function",
  "module",
  "abs_path",
  "context_line",
  "instruction_addr",
  "addr_mode",
  "chunk_id",
] as const;

const STACK_FRAME_STRING_ARRAY_KEYS = ["pre_context", "post_context"] as const;

function sanitizeStackFrame(frame: unknown): unknown {
  if (typeof frame !== "object" || frame == null) return frame;
  const next: Record<string, unknown> = { ...(frame as Record<string, unknown>) };
  for (const key of STACK_FRAME_STRING_KEYS) {
    const value = next[key];
    if (typeof value === "string") next[key] = redactOutboundSecrets(value);
  }
  for (const key of STACK_FRAME_STRING_ARRAY_KEYS) {
    if (key in next) {
      const value = next[key];
      next[key] = Array.isArray(value)
        ? value.map((entry) => (typeof entry === "string" ? redactOutboundSecrets(entry) : entry))
        : value;
    }
  }
  return next;
}

function sanitizeExceptionEntry(entry: unknown): unknown {
  if (typeof entry !== "object" || entry == null) return entry;
  const next: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  if (typeof next.type === "string") next.type = redactOutboundSecrets(next.type);
  if (typeof next.value === "string") next.value = redactOutboundSecrets(next.value);
  if (typeof next.module === "string") next.module = redactOutboundSecrets(next.module);
  const stacktrace = next.stacktrace;
  if (typeof stacktrace === "object" && stacktrace != null) {
    const stack = { ...(stacktrace as Record<string, unknown>) };
    if (Array.isArray(stack.frames)) {
      stack.frames = stack.frames.map(sanitizeStackFrame);
    }
    next.stacktrace = stack;
  }
  return next;
}

export function sanitizePostHogEvent(
  event: PostHogEventMessage | null,
): PostHogEventMessage | null {
  if (event == null) return null;
  const properties = event.properties;
  if (properties == null) return event;

  const errorMessage = properties.error_message;
  const exceptionList = properties.$exception_list;
  const hasErrorMessage = typeof errorMessage === "string";
  const hasExceptionList = Array.isArray(exceptionList);
  if (!hasErrorMessage && !hasExceptionList) return event;

  const nextProperties: Record<string | number, unknown> = { ...properties };
  if (hasErrorMessage) {
    nextProperties.error_message = redactOutboundSecrets(errorMessage);
  }
  if (hasExceptionList) {
    nextProperties.$exception_list = exceptionList.map(sanitizeExceptionEntry);
  }
  return { ...event, properties: nextProperties };
}
