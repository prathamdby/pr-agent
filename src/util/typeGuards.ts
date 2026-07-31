/** True for non-null objects, including arrays and boxed primitives. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

/** True for non-null plain objects only (excludes arrays). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
