import * as v from "valibot";
import { logDebug } from "../../evlog.js";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import { formatValidationIssues } from "../../util/formatValidationIssues.js";

/**
 * Validate-then-repair parse seam for tool inputs. Valid input passes
 * through untouched; only on validation failure are four ordered,
 * deterministic repairs tried, and only at the paths the validator actually
 * flagged. Every applied repair is logged with the tool name and repair
 * kind. Unrepairable input returns the model-readable issue list.
 *
 * The catalogue is deliberately limited to the four observed shape errors —
 * no numeric-string coercion (a numeric string is a valid `path`), no
 * generic normalization framework.
 */

export type ToolInputRepairKind =
  | "null_optional_dropped"
  | "stringified_json_array"
  | "object_wrapped_as_array"
  | "string_wrapped_as_array";

export type ParsedToolInput<T> =
  | { readonly ok: true; readonly value: T; readonly repairs: readonly ToolInputRepairKind[] }
  | { readonly ok: false; readonly error: string; readonly issues: readonly v.GenericIssue[] };

type SchemaNode = {
  readonly type?: string;
  readonly wrapped?: unknown;
  readonly entries?: Record<string, unknown>;
  readonly item?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwrap optional/nullish/nullable layers to reach the base node. */
function baseNode(node: SchemaNode): SchemaNode {
  let current = node;
  while (
    (current.type === "optional" || current.type === "nullish" || current.type === "nullable") &&
    isPlainObject(current.wrapped)
  ) {
    current = current.wrapped;
  }
  return current;
}

/**
 * Resolve the schema node at a validator dot path. Numeric segments index
 * into array item schemas. Returns null for unions, unknown keys, or any
 * shape we cannot walk — an unresolvable path is simply never repaired.
 */
function schemaNodeAtPath(schema: v.GenericSchema, dotPath: string): SchemaNode | null {
  let current: SchemaNode = schema as unknown as SchemaNode;
  if (dotPath === "") return current;
  for (const segment of dotPath.split(".")) {
    const base = baseNode(current);
    if (base.type === "object" && isPlainObject(base.entries)) {
      const next: unknown = base.entries[segment];
      if (!isPlainObject(next)) return null;
      current = next;
    } else if (base.type === "array" && /^\d+$/.test(segment)) {
      if (!isPlainObject(base.item)) return null;
      current = base.item;
    } else {
      return null;
    }
  }
  return current;
}

function tryParseJsonArray(value: string): unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type AppliedRepair = {
  readonly kind: ToolInputRepairKind;
  readonly value?: unknown;
};

/**
 * The four ordered repairs for one failing path. Rule 2 runs before rule 4
 * so a stringified array is parsed, never double-wrapped. At most one repair
 * applies per path.
 */
function repairAt(node: SchemaNode, value: unknown): AppliedRepair | null {
  if (value === null && (node.type === "optional" || node.type === "nullish")) {
    return { kind: "null_optional_dropped" };
  }
  const base = baseNode(node);
  if (base.type !== "array") return null;
  if (typeof value === "string") {
    const parsed = tryParseJsonArray(value);
    if (parsed !== null) {
      return { kind: "stringified_json_array", value: parsed };
    }
  }
  if (isPlainObject(value)) {
    return { kind: "object_wrapped_as_array", value: [value] };
  }
  if (typeof value === "string" && isPlainObject(base.item)) {
    const item = baseNode(base.item);
    if (item.type === "string") {
      return { kind: "string_wrapped_as_array", value: [value] };
    }
  }
  return null;
}

type RepairTarget =
  | { readonly parent: Record<string, unknown>; readonly key: string }
  | { readonly parent: unknown[]; readonly key: number }
  | { readonly parent: null; readonly key: null };

/** Locate the writable parent container for a dot path inside the cloned args. */
function resolveRepairTarget(root: unknown, segments: readonly string[]): RepairTarget | null {
  if (segments.length === 0) return { parent: null, key: null };
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return null;
    }
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(current) && /^\d+$/.test(last)) {
    return { parent: current, key: Number(last) };
  }
  if (isPlainObject(current)) {
    return { parent: current, key: last };
  }
  return null;
}

export function parseToolInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: unknown,
  opts: { readonly toolName: string; readonly errorTitle?: string },
): ParsedToolInput<v.InferOutput<TSchema>> {
  const first = v.safeParse(schema, raw);
  if (first.success) {
    return { ok: true, value: first.output as v.InferOutput<TSchema>, repairs: [] };
  }

  const title = opts.errorTitle ?? "Tool input validation failed:";
  const failingPaths = new Set<string>();
  for (const issue of first.issues) {
    failingPaths.add(v.getDotPath(issue) ?? "");
  }

  let candidate: unknown = structuredClone(raw);
  const repairs: ToolInputRepairKind[] = [];
  for (const path of failingPaths) {
    const node = schemaNodeAtPath(schema, path);
    if (node === null) continue;
    const segments = path === "" ? [] : path.split(".");
    const target = resolveRepairTarget(candidate, segments);
    if (target === null) continue;
    const value =
      target.parent === null ? candidate : (target.parent as Record<string, unknown>)[target.key];
    const repair = repairAt(node, value);
    if (repair === null) continue;
    if (repair.kind === "null_optional_dropped") {
      // Deleting a key only makes sense on an object parent; a null array
      // item is never spliced out from under the model's ordering.
      if (!isPlainObject(target.parent)) continue;
      delete target.parent[target.key as string];
    } else if (target.parent === null) {
      candidate = repair.value;
    } else {
      (target.parent as Record<string, unknown>)[target.key] = repair.value;
    }
    repairs.push(repair.kind);
  }

  if (repairs.length > 0) {
    logDebug("tool_input_repaired", { tool: opts.toolName, repairs });
    recordReviewMetric({ kind: "tool_input_repaired", tool: opts.toolName, repairs });
  }

  if (repairs.length === 0) {
    return { ok: false, error: formatValidationIssues(first.issues, title), issues: first.issues };
  }
  const second = v.safeParse(schema, candidate);
  if (!second.success) {
    return {
      ok: false,
      error: formatValidationIssues(second.issues, title),
      issues: second.issues,
    };
  }
  return { ok: true, value: second.output as v.InferOutput<TSchema>, repairs };
}
