import * as v from "valibot";
import { logDebug } from "../../evlog.js";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.js";
import { formatValidationIssues } from "../../util/formatValidationIssues.js";
import {
  asJsonObject,
  isJsonString,
  parseJsonText,
  type JsonArray,
  type JsonValue,
} from "../../util/jsonValue.js";

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

type ValibotWalkNode = {
  readonly type?: string;
  readonly wrapped?: ValibotWalkNode;
  readonly entries?: { readonly [key: string]: ValibotWalkNode };
  readonly item?: ValibotWalkNode;
};

type MutableJsonObject = { [key: string]: JsonValue };
type MutableJsonArray = JsonValue[];

function isWalkNode(value: ValibotWalkNode | JsonValue | undefined): value is ValibotWalkNode {
  return value instanceof Object && !Array.isArray(value);
}

/** Unwrap optional/nullish/nullable layers to reach the base node. */
function baseNode(node: ValibotWalkNode): ValibotWalkNode {
  let current = node;
  while (
    (current.type === "optional" || current.type === "nullish" || current.type === "nullable") &&
    isWalkNode(current.wrapped)
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
function schemaNodeAtPath(schema: v.GenericSchema, dotPath: string): ValibotWalkNode | null {
  // SAFETY: Valibot GenericSchema instances expose type, wrapped, entries, and item for this repair walk.
  let current = schema as ValibotWalkNode;
  if (dotPath === "") return current;
  for (const segment of dotPath.split(".")) {
    const base = baseNode(current);
    if (base.type === "object" && isWalkNode(base.entries)) {
      const next = base.entries[segment];
      if (!isWalkNode(next)) return null;
      current = next;
    } else if (base.type === "array" && /^\d+$/.test(segment)) {
      if (!isWalkNode(base.item)) return null;
      current = base.item;
    } else {
      return null;
    }
  }
  return current;
}

function tryParseJsonArray(value: string): JsonArray | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = parseJsonText(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type AppliedRepair = {
  readonly kind: ToolInputRepairKind;
  readonly value?: JsonValue;
};

/**
 * The four ordered repairs for one failing path. Rule 2 runs before rule 4
 * so a stringified array is parsed, never double-wrapped. At most one repair
 * applies per path.
 */
function repairAt(node: ValibotWalkNode, value: JsonValue): AppliedRepair | null {
  if (value === null && (node.type === "optional" || node.type === "nullish")) {
    return { kind: "null_optional_dropped" };
  }
  const base = baseNode(node);
  if (base.type !== "array") return null;
  if (isJsonString(value)) {
    const parsed = tryParseJsonArray(value);
    if (parsed !== null) {
      return { kind: "stringified_json_array", value: parsed };
    }
  }
  const objectValue = asJsonObject(value);
  if (objectValue !== null) {
    return { kind: "object_wrapped_as_array", value: [objectValue] };
  }
  if (isJsonString(value) && isWalkNode(base.item)) {
    const item = baseNode(base.item);
    if (item.type === "string") {
      return { kind: "string_wrapped_as_array", value: [value] };
    }
  }
  return null;
}

type RepairTarget =
  | { readonly kind: "root" }
  | { readonly kind: "object"; readonly parent: MutableJsonObject; readonly key: string }
  | { readonly kind: "array"; readonly parent: MutableJsonArray; readonly key: number };

/** Locate the writable parent container for a dot path inside the cloned args. */
function resolveRepairTarget(root: JsonValue, segments: readonly string[]): RepairTarget | null {
  if (segments.length === 0) return { kind: "root" };
  let current: JsonValue = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const next = current[Number(segment)];
      if (next === undefined) return null;
      current = next;
    } else {
      const objectCurrent = asJsonObject(current);
      if (objectCurrent === null) return null;
      const next = objectCurrent[segment];
      if (next === undefined) return null;
      current = next;
    }
  }
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  if (Array.isArray(current) && /^\d+$/.test(last)) {
    // SAFETY: structuredClone of a JsonValue array is a mutable JSON array used only for in-place repair.
    return { kind: "array", parent: current as MutableJsonArray, key: Number(last) };
  }
  const objectCurrent = asJsonObject(current);
  if (objectCurrent !== null) {
    // SAFETY: structuredClone of a JsonObject is a mutable JSON object used only for in-place repair.
    return { kind: "object", parent: objectCurrent as MutableJsonObject, key: last };
  }
  return null;
}

export function parseToolInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: JsonValue,
  opts: { readonly toolName: string; readonly errorTitle?: string },
): ParsedToolInput<v.InferOutput<TSchema>> {
  const first = v.safeParse(schema, raw);
  if (first.success) {
    return { ok: true, value: first.output, repairs: [] };
  }

  const title = opts.errorTitle ?? "Tool input validation failed:";
  const failingPaths = new Set<string>();
  for (const issue of first.issues) {
    failingPaths.add(v.getDotPath(issue) ?? "");
  }

  let candidate: JsonValue = structuredClone(raw);
  const repairs: ToolInputRepairKind[] = [];
  for (const path of failingPaths) {
    const node = schemaNodeAtPath(schema, path);
    if (node === null) continue;
    const segments = path === "" ? [] : path.split(".");
    const target = resolveRepairTarget(candidate, segments);
    if (target === null) continue;
    const value =
      target.kind === "root"
        ? candidate
        : target.kind === "array"
          ? target.parent[target.key]
          : target.parent[target.key];
    if (value === undefined) continue;
    const repair = repairAt(node, value);
    if (repair === null) continue;
    if (repair.kind === "null_optional_dropped") {
      if (target.kind !== "object") continue;
      delete target.parent[target.key];
    } else if (target.kind === "root") {
      if (repair.value === undefined) continue;
      candidate = repair.value;
    } else if (target.kind === "array") {
      if (repair.value === undefined) continue;
      target.parent[target.key] = repair.value;
    } else {
      if (repair.value === undefined) continue;
      target.parent[target.key] = repair.value;
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
  return { ok: true, value: second.output, repairs };
}
