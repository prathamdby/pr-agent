import * as v from "valibot";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue | undefined };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.string(),
    v.number(),
    v.boolean(),
    v.array(jsonValueSchema),
    v.record(v.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: v.GenericSchema<JsonObject> = v.record(v.string(), jsonValueSchema);

export function parseJsonText(text: string): JsonValue {
  return v.parse(jsonValueSchema, JSON.parse(text));
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  if (value === undefined || Array.isArray(value)) return false;
  return v.is(jsonObjectSchema, value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return v.is(v.string(), value);
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return v.is(v.number(), value);
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return v.is(v.boolean(), value);
}

export function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null;
}
