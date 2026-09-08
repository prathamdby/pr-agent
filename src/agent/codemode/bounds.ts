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
