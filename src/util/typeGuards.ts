export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown) {
  return ((pinnedReturn: string | undefined) => pinnedReturn)(
    typeof value === "string" && value.length > 0 ? value : undefined,
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
