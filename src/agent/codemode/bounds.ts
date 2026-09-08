import {
  CODE_MODE_MAX_ARRAY_ALLOCATION,
  CODE_MODE_MAX_REGEX_INPUT_CHARS,
  CODE_MODE_MAX_STRING_REPEAT,
} from "../../settings/index.js";
import { CodeModeHostHalt } from "./hostHalt.js";

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function assertSafePropertyKey(key: unknown): void {
  if (typeof key === "string" && BLOCKED_KEYS.has(key)) {
    throw new CodeModeHostHalt("EXECUTION_ERROR", `Prototype navigation blocked: ${key}`);
  }
}

export function boundStringConcat(left: string, right: string): string {
  if (left.length + right.length > CODE_MODE_MAX_STRING_REPEAT) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      `String concatenation exceeds ${CODE_MODE_MAX_STRING_REPEAT} characters`,
    );
  }
  return left + right;
}

export function boundArrayFrom(source: unknown): unknown[] {
  if (source == null) return [];
  if (typeof source === "string") {
    boundArrayLength(source.length);
    return Array.from(source);
  }
  if (typeof source === "object" && "length" in source) {
    const length = Number(source.length);
    boundArrayLength(length);
    const out: unknown[] = [];
    const record: Record<number, unknown> = source;
    for (let i = 0; i < length; i += 1) out.push(record[i]);
    return out;
  }
  if (typeof (source as Iterable<unknown>)[Symbol.iterator] === "function") {
    const out: unknown[] = [];
    for (const item of source as Iterable<unknown>) {
      if (out.length >= CODE_MODE_MAX_ARRAY_ALLOCATION) {
        throw new CodeModeHostHalt(
          "LIMIT_EXCEEDED",
          `Array allocation exceeds ${CODE_MODE_MAX_ARRAY_ALLOCATION} elements`,
        );
      }
      out.push(item);
    }
    return out;
  }
  return [];
}

export function boundStringRepeat(value: string, count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      "String.repeat count must be a finite non-negative number",
    );
  }
  const next = Math.floor(count);
  const produced = value.length * next;
  if (produced > CODE_MODE_MAX_STRING_REPEAT) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      `String.repeat allocation exceeds ${CODE_MODE_MAX_STRING_REPEAT} characters`,
    );
  }
  return String.prototype.repeat.call(value, next);
}

export function boundArrayLength(length: number): number {
  if (!Number.isFinite(length) || length < 0) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      "Array length must be a finite non-negative number",
    );
  }
  const next = Math.floor(length);
  if (next > CODE_MODE_MAX_ARRAY_ALLOCATION) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      `Array allocation exceeds ${CODE_MODE_MAX_ARRAY_ALLOCATION} elements`,
    );
  }
  return next;
}

export function assertSafeRegexInput(input: string): void {
  if (input.length > CODE_MODE_MAX_REGEX_INPUT_CHARS) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      `Regular expression input exceeds ${CODE_MODE_MAX_REGEX_INPUT_CHARS} characters`,
    );
  }
}

const CATASTROPHIC_PATTERN =
  /(\([^?*+][^)]*[+*]\)[+*])|((?:\.|[^\n])[+*](?:\?|\+|\*){1,})|(\([^)]*[+*]\)\{(?:\d{3,}|\d+,\d{3,})\})/;

export function assertSafeRegexPattern(pattern: string): void {
  if (pattern.length > CODE_MODE_MAX_REGEX_INPUT_CHARS) {
    throw new CodeModeHostHalt("LIMIT_EXCEEDED", "Regular expression pattern is too long");
  }
  if (CATASTROPHIC_PATTERN.test(pattern)) {
    throw new CodeModeHostHalt(
      "LIMIT_EXCEEDED",
      "Regular expression pattern rejected as ReDoS-prone",
    );
  }
}
