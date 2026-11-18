import { createHash } from "node:crypto";
import { isPlainObject } from "../util/typeGuards.ts";

export const TRACE_CONTENT_TRUNCATED = "[trace content truncated]";
export const TRACE_MESSAGE_CHARS = 8_192;
export const TRACE_SYSTEM_CHARS = 24_576;
export const TRACE_TOOL_STATE_CHARS = 16_384;
export const TRACE_ERROR_CHARS = 2_000;
export const TRACE_FINDING_CHARS = 500;
export const TRACE_FINDING_LIMIT = 12;
export const TRACE_LAST_TURNS = 6;
export const TRACE_HASH_PREFIX = 12;

const BOUND_DEPTH = 8;

export type PostHogPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "function";
      readonly id: string;
      readonly function: { readonly name: string; readonly arguments: unknown };
    }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string };

export type PostHogMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly PostHogPart[];
};

export type FindingSnapshot = {
  readonly file: string;
  readonly title: string;
  readonly severity?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly detail?: string;
};

export function sha256Hex(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(createHash("sha256").update(text).digest("hex"));
}

export function safeJson(value: unknown) {
  try {
    return ((pinnedReturn: string) => pinnedReturn)(JSON.stringify(value) ?? "");
  } catch {
    return ((pinnedReturn: string) => pinnedReturn)(TRACE_CONTENT_TRUNCATED);
  }
}

export function boundText(text: string, limit: number) {
  if (text.length <= limit)
    return ((pinnedReturn: { readonly text: string; readonly truncated: boolean }) => pinnedReturn)(
      { text, truncated: false },
    );
  const marker = `\n${TRACE_CONTENT_TRUNCATED}`;
  const keep = Math.max(0, limit - marker.length);
  return ((pinnedReturn: { readonly text: string; readonly truncated: boolean }) => pinnedReturn)({
    text: `${text.slice(0, keep)}${marker}`,
    truncated: true,
  });
}

export function boundTraceValue(value: unknown, stringLimit: number, totalLimit: number) {
  try {
    const bounded = boundStrings(value, stringLimit, 0, new WeakSet());
    const json = safeJson(bounded);
    if (json.length <= totalLimit) return ((pinnedReturn: unknown) => pinnedReturn)(bounded);
    return ((pinnedReturn: unknown) => pinnedReturn)(boundText(json, totalLimit).text);
  } catch {
    return ((pinnedReturn: unknown) => pinnedReturn)(TRACE_CONTENT_TRUNCATED);
  }
}

export function toPostHogOutputChoices(parts: readonly PostHogPart[]) {
  if (parts.length === 0) return ((pinnedReturn: unknown[]) => pinnedReturn)([]);
  return ((pinnedReturn: unknown[]) => pinnedReturn)([{ role: "assistant", content: parts }]);
}

export function findingSnapshots(value: unknown) {
  const found: FindingSnapshot[] = [];
  const visit = (current: unknown, depth: number, inFindings: boolean) => {
    if (found.length >= TRACE_FINDING_LIMIT || depth > BOUND_DEPTH) return;
    if (Array.isArray(current)) {
      for (const item of current) {
        if (inFindings && isFinding(item)) found.push(snapshot(item));
        else visit(item, depth + 1, inFindings);
      }
      return;
    }
    if (!isPlainObject(current)) return;
    for (const [key, item] of Object.entries(current)) {
      visit(item, depth + 1, inFindings || key === "findings");
    }
  };
  try {
    visit(value, 0, false);
  } catch {
    return ((pinnedReturn: FindingSnapshot[]) => pinnedReturn)(found);
  }
  return ((pinnedReturn: FindingSnapshot[]) => pinnedReturn)(found);
}

const boundStrings: (
  value: unknown,
  stringLimit: number,
  depth: number,
  seen: WeakSet<object>,
) => unknown = (value: unknown, stringLimit: number, depth: number, seen: WeakSet<object>) => {
  if (typeof value === "string")
    return ((pinnedReturn: unknown) => pinnedReturn)(boundText(value, stringLimit).text);
  if (typeof value === "number" || typeof value === "boolean" || value == null)
    return ((pinnedReturn: unknown) => pinnedReturn)(value);
  if (depth >= BOUND_DEPTH || typeof value !== "object")
    return ((pinnedReturn: unknown) => pinnedReturn)(TRACE_CONTENT_TRUNCATED);
  if (seen.has(value)) return ((pinnedReturn: unknown) => pinnedReturn)(TRACE_CONTENT_TRUNCATED);
  seen.add(value);
  if (Array.isArray(value)) {
    return ((pinnedReturn: unknown) => pinnedReturn)(
      value.map((item) => boundStrings(item, stringLimit, depth + 1, seen)),
    );
  }
  if (!isPlainObject(value))
    return ((pinnedReturn: unknown) => pinnedReturn)(TRACE_CONTENT_TRUNCATED);
  return ((pinnedReturn: unknown) => pinnedReturn)(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        boundStrings(item, stringLimit, depth + 1, seen),
      ]),
    ),
  );
};

type FindingRecord = Record<string, unknown> & { readonly file: string; readonly title: string };

function isFinding(value: unknown): value is FindingRecord {
  return (
    isPlainObject(value) &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    (typeof value.severity === "string" || typeof value.startLine === "number")
  );
}

function snapshot(finding: FindingRecord) {
  const detail =
    typeof finding.detail === "string"
      ? boundText(finding.detail, TRACE_FINDING_CHARS).text
      : undefined;
  return ((pinnedReturn: FindingSnapshot) => pinnedReturn)({
    file: boundText(finding.file, TRACE_FINDING_CHARS).text,
    title: boundText(finding.title, TRACE_FINDING_CHARS).text,
    ...(typeof finding.severity === "string" ? { severity: finding.severity } : {}),
    ...(typeof finding.startLine === "number" ? { startLine: finding.startLine } : {}),
    ...(typeof finding.endLine === "number" ? { endLine: finding.endLine } : {}),
    ...(detail != null ? { detail } : {}),
  });
}
