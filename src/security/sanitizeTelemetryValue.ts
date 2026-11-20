import { redactOutboundSecrets } from "./redactOutboundSecrets.ts";
import { defineEnumerable } from "../util/defineEnumerable.ts";
import { isRecord } from "../util/typeGuards.ts";

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

function sanitizeString(value: string) {
  return ((pinnedReturn: string) => pinnedReturn)(redactOutboundSecrets(value));
}

function readProperty(value: object, key: string) {
  try {
    if (!(key in value))
      return ((pinnedReturn: { readonly present: boolean; readonly value?: unknown }) =>
        pinnedReturn)({ present: false });
    return ((pinnedReturn: { readonly present: boolean; readonly value?: unknown }) =>
      pinnedReturn)({ present: true, value: Reflect.get(value, key) });
  } catch {
    return ((pinnedReturn: { readonly present: boolean; readonly value?: unknown }) =>
      pinnedReturn)({ present: true, value: UNSUPPORTED_VALUE });
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

function isSensitiveTelemetryKey(key: string) {
  const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
  if (SENSITIVE_TELEMETRY_KEYS.has(normalized))
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  for (const sensitive of SENSITIVE_TELEMETRY_KEY_SUFFIXES) {
    if (normalized.endsWith(sensitive) && normalized.length > sensitive.length)
      return ((pinnedReturn: boolean) => pinnedReturn)(true);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(false);
}

function sanitizeError(error: Error, ancestors: WeakSet<object>, depth: number) {
  if (ancestors.has(error))
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: CIRCULAR_VALUE,
      changed: true,
    });
  if (depth >= MAX_TELEMETRY_DEPTH)
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: UNSUPPORTED_VALUE,
      changed: true,
    });

  ancestors.add(error);
  try {
    const next: Record<string, unknown> = {};
    const name = readProperty(error, "name");
    const message = readProperty(error, "message");
    defineEnumerable(
      next,
      "name",
      sanitizeString(typeof name.value === "string" ? name.value : "Error"),
    );
    defineEnumerable(
      next,
      "message",
      sanitizeString(typeof message.value === "string" ? message.value : ""),
    );

    const stack = readProperty(error, "stack");
    if (stack.present && typeof stack.value === "string") {
      defineEnumerable(next, "stack", sanitizeString(stack.value));
    }

    const cause = readProperty(error, "cause");
    if (cause.present) {
      defineEnumerable(next, "cause", sanitizeValue(cause.value, ancestors, depth + 1).value);
    }

    for (const key of Object.keys(error)) {
      if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
      if (isSensitiveTelemetryKey(key)) {
        defineEnumerable(next, key, "[redacted]");
        continue;
      }
      defineEnumerable(
        next,
        key,
        sanitizeValue(Reflect.get(error, key), ancestors, depth + 1).value,
      );
    }
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({ value: next, changed: true });
  } catch {
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: UNSUPPORTED_VALUE,
      changed: true,
    });
  } finally {
    ancestors.delete(error);
  }
}

const sanitizeObject: (
  object: object,
  ancestors: WeakSet<object>,
  depth: number,
) => SanitizedValue = (object: object, ancestors: WeakSet<object>, depth: number) => {
  if (ancestors.has(object))
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: CIRCULAR_VALUE,
      changed: true,
    });
  if (depth >= MAX_TELEMETRY_DEPTH)
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: UNSUPPORTED_VALUE,
      changed: true,
    });

  if (object instanceof Date) {
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: Number.isNaN(object.getTime())
        ? "[invalid date]"
        : sanitizeString(object.toISOString()),
      changed: true,
    });
  }
  if (object instanceof URL)
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: sanitizeString(object.toString()),
      changed: true,
    });
  if (object instanceof RegExp)
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: sanitizeString(object.toString()),
      changed: true,
    });
  if (object instanceof Map || object instanceof Set) {
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: UNSUPPORTED_VALUE,
      changed: true,
    });
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
      return ((pinnedReturn: SanitizedValue) => pinnedReturn)(
        changed ? { value: next, changed: true } : { value: object, changed: false },
      );
    }

    const toJson = readProperty(object, "toJSON");
    if (toJson.present && typeof toJson.value === "function") {
      return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
        value: UNSUPPORTED_VALUE,
        changed: true,
      });
    }

    const next: Record<string, unknown> = {};
    let changed = false;
    for (const key of Object.keys(object)) {
      if (isSensitiveTelemetryKey(key)) {
        defineEnumerable(next, key, "[redacted]");
        changed = true;
        continue;
      }
      const sanitized = sanitizeValue(Reflect.get(object, key), ancestors, depth + 1);
      defineEnumerable(next, key, sanitized.value);
      changed ||= sanitized.changed;
    }
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)(
      changed ? { value: next, changed: true } : { value: object, changed: false },
    );
  } catch {
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: UNSUPPORTED_VALUE,
      changed: true,
    });
  } finally {
    ancestors.delete(object);
  }
};

const sanitizeValue: (
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
) => SanitizedValue = (value: unknown, ancestors: WeakSet<object>, depth: number) => {
  if (typeof value === "string") {
    const sanitized = sanitizeString(value);
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: sanitized,
      changed: sanitized !== value,
    });
  }
  if (value === null || value === undefined || typeof value === "boolean") {
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({ value, changed: false });
  }
  if (typeof value === "number") {
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)(
      Number.isFinite(value) ? { value, changed: false } : { value: String(value), changed: true },
    );
  }
  if (typeof value === "bigint")
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: value.toString(),
      changed: true,
    });
  if (typeof value === "symbol") {
    const description = value.description;
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: description === undefined ? "Symbol" : `Symbol(${sanitizeString(description)})`,
      changed: true,
    });
  }
  if (typeof value === "function")
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)({
      value: UNSUPPORTED_VALUE,
      changed: true,
    });
  if (value instanceof Error)
    return ((pinnedReturn: SanitizedValue) => pinnedReturn)(sanitizeError(value, ancestors, depth));
  return ((pinnedReturn: SanitizedValue) => pinnedReturn)(sanitizeObject(value, ancestors, depth));
};

export function sanitizeTelemetryString(value: string) {
  return ((pinnedReturn: string) => pinnedReturn)(sanitizeString(value));
}

export function sanitizeTelemetryValue(value: unknown) {
  return ((pinnedReturn: unknown) => pinnedReturn)(
    sanitizeValue(value, new WeakSet<object>(), 0).value,
  );
}

export function sanitizeTelemetryRecord(value: Record<string, unknown> | undefined) {
  if (value === undefined)
    return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(undefined);
  const sanitized = sanitizeTelemetryValue(value);
  return ((pinnedReturn: Record<string, unknown> | undefined) => pinnedReturn)(
    isRecord(sanitized) ? sanitized : {},
  );
}
