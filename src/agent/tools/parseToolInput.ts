import * as v from "valibot";
import { logDebug } from "../../evlog.ts";
import { recordReviewMetric } from "../../review/run/reviewRunMetrics.ts";
import { formatValidationIssues } from "../../util/formatValidationIssues.ts";
import { isPlainObject } from "../../util/typeGuards.ts";

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

function baseNode(node: SchemaNode) {
  let current = node;
  while (
    (current.type === "optional" || current.type === "nullish" || current.type === "nullable") &&
    isPlainObject(current.wrapped)
  ) {
    current = current.wrapped;
  }
  return ((pinnedReturn: SchemaNode) => pinnedReturn)(current);
}

function schemaNodeAtPath(schema: v.GenericSchema, dotPath: string) {
  let current: SchemaNode = schema;
  if (dotPath === "") return ((pinnedReturn: SchemaNode | null) => pinnedReturn)(current);
  for (const segment of dotPath.split(".")) {
    const base = baseNode(current);
    if (base.type === "object" && isPlainObject(base.entries)) {
      const next: unknown = base.entries[segment];
      if (!isPlainObject(next)) return ((pinnedReturn: SchemaNode | null) => pinnedReturn)(null);
      current = next;
    } else if (base.type === "array" && /^\d+$/.test(segment)) {
      if (!isPlainObject(base.item))
        return ((pinnedReturn: SchemaNode | null) => pinnedReturn)(null);
      current = base.item;
    } else {
      return ((pinnedReturn: SchemaNode | null) => pinnedReturn)(null);
    }
  }
  return ((pinnedReturn: SchemaNode | null) => pinnedReturn)(current);
}

function tryParseJsonArray(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return ((pinnedReturn: unknown[] | null) => pinnedReturn)(null);
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return ((pinnedReturn: unknown[] | null) => pinnedReturn)(
      Array.isArray(parsed) ? parsed : null,
    );
  } catch {
    return ((pinnedReturn: unknown[] | null) => pinnedReturn)(null);
  }
}

type AppliedRepair = {
  readonly kind: ToolInputRepairKind;
  readonly value?: unknown;
};

function repairAt(node: SchemaNode, value: unknown) {
  if (value === null && (node.type === "optional" || node.type === "nullish")) {
    return ((pinnedReturn: AppliedRepair | null) => pinnedReturn)({
      kind: "null_optional_dropped",
    });
  }
  const base = baseNode(node);
  if (base.type !== "array") return ((pinnedReturn: AppliedRepair | null) => pinnedReturn)(null);
  if (typeof value === "string") {
    const parsed = tryParseJsonArray(value);
    if (parsed !== null) {
      return ((pinnedReturn: AppliedRepair | null) => pinnedReturn)({
        kind: "stringified_json_array",
        value: parsed,
      });
    }
  }
  if (isPlainObject(value)) {
    return ((pinnedReturn: AppliedRepair | null) => pinnedReturn)({
      kind: "object_wrapped_as_array",
      value: [value],
    });
  }
  if (typeof value === "string" && isPlainObject(base.item)) {
    const item = baseNode(base.item);
    if (item.type === "string") {
      return ((pinnedReturn: AppliedRepair | null) => pinnedReturn)({
        kind: "string_wrapped_as_array",
        value: [value],
      });
    }
  }
  return ((pinnedReturn: AppliedRepair | null) => pinnedReturn)(null);
}

type RepairTarget =
  | { readonly parent: Record<string, unknown>; readonly key: string }
  | { readonly parent: unknown[]; readonly key: number }
  | { readonly parent: null; readonly key: null };

function resolveRepairTarget(root: unknown, segments: readonly string[]) {
  if (segments.length === 0)
    return ((pinnedReturn: RepairTarget | null) => pinnedReturn)({ parent: null, key: null });
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      current = current[segment];
    } else {
      return ((pinnedReturn: RepairTarget | null) => pinnedReturn)(null);
    }
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(current) && /^\d+$/.test(last)) {
    return ((pinnedReturn: RepairTarget | null) => pinnedReturn)({
      parent: current,
      key: Number(last),
    });
  }
  if (isPlainObject(current)) {
    return ((pinnedReturn: RepairTarget | null) => pinnedReturn)({ parent: current, key: last });
  }
  return ((pinnedReturn: RepairTarget | null) => pinnedReturn)(null);
}

export function parseToolInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: unknown,
  opts: { readonly toolName: string; readonly errorTitle?: string },
) {
  const first = v.safeParse(schema, raw);
  if (first.success) {
    return ((pinnedReturn: ParsedToolInput<v.InferOutput<TSchema>>) => pinnedReturn)({
      ok: true,
      value: first.output,
      repairs: [],
    });
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
    const value = target.parent === null ? candidate : Reflect.get(target.parent, target.key);
    const repair = repairAt(node, value);
    if (repair === null) continue;
    if (repair.kind === "null_optional_dropped") {
      if (typeof target.key !== "string") continue;
      delete target.parent[target.key];
    } else if (target.parent === null) {
      candidate = repair.value;
    } else if (typeof target.key === "number") {
      target.parent[target.key] = repair.value;
    } else {
      target.parent[target.key] = repair.value;
    }
    repairs.push(repair.kind);
  }

  if (repairs.length > 0) {
    logDebug("tool_input_repaired", { tool: opts.toolName, repairs });
    recordReviewMetric({ kind: "tool_input_repaired", tool: opts.toolName, repairs });
  }

  if (repairs.length === 0) {
    return ((pinnedReturn: ParsedToolInput<v.InferOutput<TSchema>>) => pinnedReturn)({
      ok: false,
      error: formatValidationIssues(first.issues, title),
      issues: first.issues,
    });
  }
  const second = v.safeParse(schema, candidate);
  if (!second.success) {
    return ((pinnedReturn: ParsedToolInput<v.InferOutput<TSchema>>) => pinnedReturn)({
      ok: false,
      error: formatValidationIssues(second.issues, title),
      issues: second.issues,
    });
  }
  return ((pinnedReturn: ParsedToolInput<v.InferOutput<TSchema>>) => pinnedReturn)({
    ok: true,
    value: second.output,
    repairs,
  });
}
