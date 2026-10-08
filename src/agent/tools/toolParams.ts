import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

type JsonSchemaNode = { [key: string]: unknown };

function isSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Closed objects tell the model which keys exist. Validation stays in valibot,
 * which already strips unknown keys, so this only changes what the model sees.
 */
function closeObjects(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) closeObjects(entry);
    return;
  }
  if (!isSchemaNode(node)) return;
  if (
    node.type === "object" &&
    isSchemaNode(node.properties) &&
    !Object.hasOwn(node, "additionalProperties")
  ) {
    node.additionalProperties = false;
  }
  for (const value of Object.values(node)) closeObjects(value);
}

/** JSON Schema for a model-facing tool's parameters. */
export function toToolParameters(schema: v.GenericSchema): PiTool["parameters"] {
  const json = toJsonSchema(schema, { errorMode: "ignore" });
  closeObjects(json);
  return json;
}

export const repoPathParam = v.pipe(
  v.string(),
  v.minLength(1),
  v.description("File path relative to the repository root, for example `src/app.ts`."),
);

export const startLineParam = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.gtValue(0),
    v.description("First line to return, 1-based. Omit to start at line 1."),
  ),
);

export const maxLinesParam = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.gtValue(0),
    v.description("Number of lines to return from startLine. Omit for the default window."),
  ),
);

export const literalQueryParam = v.pipe(
  v.string(),
  v.minLength(1),
  v.description("Exact text to find. Matched literally, not as a regular expression."),
);

export const maxResultsParam = v.pipe(
  v.number(),
  v.integer(),
  v.gtValue(0),
  v.description("Most matches to return."),
);
