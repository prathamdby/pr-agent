export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function utf8ByteLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

export function asJsonObject(value: unknown): JsonObject {
  if (value == null) return {};
  const json = JSON.stringify(value);
  if (json == null) {
    throw new Error("unsupported host argument");
  }
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("host arguments must be a JSON object");
  }
  return parsed as JsonObject;
}

export function asJsonValue(value: unknown): JsonValue {
  const json = JSON.stringify(value);
  if (json == null) return null;
  return JSON.parse(json) as JsonValue;
}
