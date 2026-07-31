/** True for non-null plain objects only (excludes arrays and boxed primitives that fail object shape). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** Alias of isRecord — plain objects only. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
