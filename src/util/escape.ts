export function escape<T>(reason: string, value: unknown): T {
  void reason;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ADR 0039 confines reviewed caller-proven narrowing to this line.
  return value as T;
}
