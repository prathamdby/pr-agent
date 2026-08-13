import { redactOutboundSecrets } from "./redactOutboundSecrets.js";
import { asJsonObject, isJsonString, type JsonObject, type JsonValue } from "../util/jsonValue.js";

export type PostHogEventMessage = {
  readonly distinctId?: string;
  readonly event?: string;
  readonly properties?: JsonObject | null;
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

function sanitizeStackFrame(frame: JsonValue): JsonValue {
  const obj = asJsonObject(frame);
  if (obj === null) return frame;
  let next: JsonObject = obj;
  for (const key of STACK_FRAME_STRING_KEYS) {
    const value = next[key];
    if (value !== undefined && isJsonString(value)) {
      next = { ...next, [key]: redactOutboundSecrets(value) };
    }
  }
  for (const key of STACK_FRAME_STRING_ARRAY_KEYS) {
    const value = next[key];
    if (value === undefined || !Array.isArray(value)) continue;
    next = {
      ...next,
      [key]: value.map((entry) => (isJsonString(entry) ? redactOutboundSecrets(entry) : entry)),
    };
  }
  return next;
}

function sanitizeExceptionEntry(entry: JsonValue): JsonValue {
  const obj = asJsonObject(entry);
  if (obj === null) return entry;
  let next: JsonObject = obj;
  const typeValue = next.type;
  if (typeValue !== undefined && isJsonString(typeValue)) {
    next = { ...next, type: redactOutboundSecrets(typeValue) };
  }
  const valueField = next.value;
  if (valueField !== undefined && isJsonString(valueField)) {
    next = { ...next, value: redactOutboundSecrets(valueField) };
  }
  const moduleField = next.module;
  if (moduleField !== undefined && isJsonString(moduleField)) {
    next = { ...next, module: redactOutboundSecrets(moduleField) };
  }
  const stacktrace = next.stacktrace;
  const stack = stacktrace === undefined ? null : asJsonObject(stacktrace);
  if (stack !== null && Array.isArray(stack.frames)) {
    next = { ...next, stacktrace: { ...stack, frames: stack.frames.map(sanitizeStackFrame) } };
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
  const hasErrorMessage = errorMessage !== undefined && isJsonString(errorMessage);
  const hasExceptionList = Array.isArray(exceptionList);
  if (!hasErrorMessage && !hasExceptionList) return event;

  let nextProperties: JsonObject = properties;
  if (hasErrorMessage) {
    nextProperties = { ...nextProperties, error_message: redactOutboundSecrets(errorMessage) };
  }
  if (hasExceptionList) {
    nextProperties = {
      ...nextProperties,
      $exception_list: exceptionList.map(sanitizeExceptionEntry),
    };
  }
  return { ...event, properties: nextProperties };
}
