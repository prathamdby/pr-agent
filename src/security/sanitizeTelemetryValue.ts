import { redactOutboundSecrets } from "./redactOutboundSecrets.js";

const CIRCULAR_VALUE = "[circular]";
const UNSUPPORTED_VALUE = "[unsupported]";
const MAX_TELEMETRY_DEPTH = 32;
const SENSITIVE_TELEMETRY_KEYS = new Set([
  "authorization",
  "cookie",
  "header",
  "headers",
  "password",
  "passwd",
  "secret",
  "signature",
  "query",
  "body",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apitoken",
  "apikey",
  "privatekey",
  "clientsecret",
  "secretkey",
  "credential",
  "credentials",
  "connectionstring",
  "databaseurl",
]);

type SanitizedValue = {
  readonly value: unknown;
  readonly changed: boolean;
};

function setProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function sanitizeString(value: string): string {
  return redactOutboundSecrets(value);
}

function readProperty(
  value: object,
  key: string,
): { readonly present: boolean; readonly value?: unknown } {
  try {
    if (!(key in value)) return { present: false };
    return { present: true, value: (value as Record<string, unknown>)[key] };
  } catch {
    return { present: true, value: UNSUPPORTED_VALUE };
  }
}

const SENSITIVE_TELEMETRY_KEY_SUFFIXES = new Set([
  "token",
  "password",
  "passwd",
  "secret",
  "apikey",
  "apitoken",
  "privatekey",
  "clientsecret",
  "secretkey",
  "credential",
  "credentials",
  "connectionstring",
  "databaseurl",
  "authorization",
]);

function isSensitiveTelemetryKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
  if (SENSITIVE_TELEMETRY_KEYS.has(normalized)) return true;
  for (const sensitive of SENSITIVE_TELEMETRY_KEY_SUFFIXES) {
    if (normalized.endsWith(sensitive) && normalized.length > sensitive.length) return true;
  }
  return false;
}

function sanitizeError(error: Error, ancestors: WeakSet<object>, depth: number): SanitizedValue {
  if (ancestors.has(error)) return { value: CIRCULAR_VALUE, changed: true };
  if (depth >= MAX_TELEMETRY_DEPTH) return { value: UNSUPPORTED_VALUE, changed: true };

  ancestors.add(error);
  try {
    const next: Record<string, unknown> = {};
    const name = readProperty(error, "name");
    const message = readProperty(error, "message");
    setProperty(
      next,
      "name",
      sanitizeString(typeof name.value === "string" ? name.value : "Error"),
    );
    setProperty(
      next,
      "message",
      sanitizeString(typeof message.value === "string" ? message.value : ""),
    );

    const stack = readProperty(error, "stack");
    if (stack.present && typeof stack.value === "string") {
      setProperty(next, "stack", sanitizeString(stack.value));
    }

    const cause = readProperty(error, "cause");
    if (cause.present) {
      setProperty(next, "cause", sanitizeValue(cause.value, ancestors, depth + 1).value);
    }

    for (const key of Object.keys(error)) {
      if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
      if (isSensitiveTelemetryKey(key)) {
        setProperty(next, key, "[redacted]");
        continue;
      }
      setProperty(
        next,
        key,
        sanitizeValue((error as unknown as Record<string, unknown>)[key], ancestors, depth + 1)
          .value,
      );
    }
    return { value: next, changed: true };
  } catch {
    return { value: UNSUPPORTED_VALUE, changed: true };
  } finally {
    ancestors.delete(error);
  }
}

function sanitizeObject(object: object, ancestors: WeakSet<object>, depth: number): SanitizedValue {
  if (ancestors.has(object)) return { value: CIRCULAR_VALUE, changed: true };
  if (depth >= MAX_TELEMETRY_DEPTH) return { value: UNSUPPORTED_VALUE, changed: true };

  if (object instanceof Date) {
    return {
      value: Number.isNaN(object.getTime())
        ? "[invalid date]"
        : sanitizeString(object.toISOString()),
      changed: true,
    };
  }
  if (object instanceof URL) return { value: sanitizeString(object.toString()), changed: true };
  if (object instanceof RegExp) return { value: sanitizeString(object.toString()), changed: true };
  if (object instanceof Map || object instanceof Set) {
    return { value: UNSUPPORTED_VALUE, changed: true };
  }

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      let changed = false;
      const next = object.map((entry) => {
        const sanitized = sanitizeValue(entry, ancestors, depth + 1);
        changed ||= sanitized.changed;
        return sanitized.value;
      });
      return changed ? { value: next, changed: true } : { value: object, changed: false };
    }

    const toJson = readProperty(object, "toJSON");
    if (toJson.present && typeof toJson.value === "function") {
      return { value: UNSUPPORTED_VALUE, changed: true };
    }

    const next: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(object)) {
      if (isSensitiveTelemetryKey(key)) {
        setProperty(next, key, "[redacted]");
        changed = true;
        continue;
      }
      const sanitized = sanitizeValue(
        (object as Record<string, unknown>)[key],
        ancestors,
        depth + 1,
      );
      setProperty(next, key, sanitized.value);
      changed ||= sanitized.changed;
    }
    return changed ? { value: next, changed: true } : { value: object, changed: false };
  } catch {
    return { value: UNSUPPORTED_VALUE, changed: true };
  } finally {
    ancestors.delete(object);
  }
}

function sanitizeValue(value: unknown, ancestors: WeakSet<object>, depth: number): SanitizedValue {
  if (typeof value === "string") {
    const sanitized = sanitizeString(value);
    return { value: sanitized, changed: sanitized !== value };
  }
  if (value === null || value === undefined || typeof value === "boolean") {
    return { value, changed: false };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { value, changed: false }
      : { value: String(value), changed: true };
  }
  if (typeof value === "bigint") return { value: value.toString(), changed: true };
  if (typeof value === "symbol") {
    const description = value.description;
    return {
      value: description === undefined ? "Symbol" : `Symbol(${sanitizeString(description)})`,
      changed: true,
    };
  }
  if (typeof value === "function") return { value: UNSUPPORTED_VALUE, changed: true };
  if (value instanceof Error) return sanitizeError(value, ancestors, depth);
  return sanitizeObject(value, ancestors, depth);
}

export function sanitizeTelemetryString(value: string): string {
  return sanitizeString(value);
}

/** Return a JSON-safe, recursively redacted value without mutating the input. */
export function sanitizeTelemetryValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>(), 0).value;
}

export function sanitizeTelemetryRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const sanitized = sanitizeTelemetryValue(value);
  if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) return {};
  return sanitized as Record<string, unknown>;
}
