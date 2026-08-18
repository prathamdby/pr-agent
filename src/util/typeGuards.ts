/** Non-null non-array objects, including Dates, Maps, and class instances. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/**
 * Object literals and null-prototype records only. Dates, Maps, and class
 * instances fail so sanitizers and tool-input repair do not treat them as
 * JSON-shaped bags.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
